from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from pydantic import Field, model_validator

from nao_core.config.exceptions import InitError
from nao_core.deps import require_dependency
from nao_core.ui import ask_confirm, ask_text

if TYPE_CHECKING:
    from vertica_python.vertica.connection import Connection

from .base import DatabaseConfig
from .context import DatabaseContext

DEFAULT_SCHEMA = "public"

# Vertica's TLS ladder, identical in meaning to libpq's sslmode and accepted
# verbatim by vertica-python's "tlsmode" connection option.
VerticaTlsMode = Literal["disable", "prefer", "require", "verify-ca", "verify-full"]
TLS_MODES: tuple[str, ...] = ("disable", "prefer", "require", "verify-ca", "verify-full")


def _quote_identifier(value: str) -> str:
    escaped = value.replace('"', '""')
    return f'"{escaped}"'


def _quote_literal(value: str) -> str:
    return value.replace("'", "''")


class VerticaBackend:
    """Lightweight backend adapter over vertica-python.

    Vertica speaks its own wire protocol rather than the Postgres one, and Ibis
    ships no Vertica backend, so this exposes only the slice of the Ibis surface
    the sync pipeline calls: ``raw_sql``, ``list_databases``, ``list_tables`` and
    ``disconnect``. ``VerticaDatabaseContext`` overrides every context method
    that would otherwise need an Ibis table expression.
    """

    def __init__(self, conn: Connection, default_schema: str) -> None:
        self._conn = conn
        self._default_schema = default_schema

    def raw_sql(self, sql: str):
        cursor = self._conn.cursor()
        cursor.execute(sql)
        return cursor

    def list_databases(self) -> list[str]:
        rows = self.raw_sql(
            "SELECT schema_name FROM v_catalog.schemata WHERE NOT is_system_schema ORDER BY schema_name"
        ).fetchall()
        return [str(row[0]) for row in rows if row and row[0]]

    def list_tables(self, database: str | None = None) -> list[str]:
        schema = _quote_literal(database or self._default_schema)
        rows = self.raw_sql(
            f"SELECT table_name FROM v_catalog.tables WHERE table_schema = '{schema}' "
            f"UNION SELECT table_name FROM v_catalog.views WHERE table_schema = '{schema}' "
            f"ORDER BY 1"
        ).fetchall()
        return [str(row[0]) for row in rows if row and row[0]]

    def disconnect(self) -> None:
        self._conn.close()


class VerticaDatabaseContext(DatabaseContext):
    """Vertica context reading metadata from the v_catalog system schema."""

    def columns(self) -> list[dict[str, Any]]:
        if self._columns_cache is None:
            comments = self._fetch_column_comments()
            rows = self._fetchall(self._conn.raw_sql(self._columns_sql()))  # type: ignore[union-attr]
            self._columns_cache = [
                {
                    "name": str(row[0]),
                    "type": self._format_type(str(row[1]), bool(row[2])),
                    "nullable": bool(row[2]),
                    "description": comments.get(str(row[0])),
                }
                for row in rows
            ]
        return self._filter_excluded_columns(self._columns_cache)

    def description(self) -> str | None:
        query = (
            "SELECT comment FROM v_catalog.comments "
            "WHERE object_type = 'TABLE' "
            f"AND object_schema = '{_quote_literal(self._schema)}' "
            f"AND object_name = '{_quote_literal(self._table_name)}'"
        )
        try:
            row = self._fetchone(self._conn.raw_sql(query))  # type: ignore[union-attr]
        except Exception:
            return None
        if row and row[0]:
            return str(row[0]).strip() or None
        return None

    def row_count(self) -> int:
        if self._row_count_cache is None:
            row = self._fetchone(
                self._conn.raw_sql(f"SELECT COUNT(*) FROM {self._qualified_table_sql()}")  # type: ignore[union-attr]
            )
            self._row_count_cache = int(row[0]) if row and row[0] is not None else 0
        return self._row_count_cache

    def preview(self, limit: int = 10) -> list[dict[str, Any]]:
        safe_limit = max(0, int(limit))
        cursor = self._conn.raw_sql(f"SELECT * FROM {self._qualified_table_sql()} LIMIT {safe_limit}")  # type: ignore[union-attr]
        rows = cursor.fetchall()
        names = [str(column[0]) for column in cursor.description] if cursor.description else []

        previews = []
        for row in rows:
            record = dict(zip(names, row, strict=False))
            for key, value in record.items():
                if value is not None and not isinstance(value, (str, int, float, bool, list, dict)):
                    record[key] = str(value)
            previews.append(self._filter_excluded_row(record))
        return previews

    def clustering_columns(self) -> list[str]:
        """Return the super projection's ORDER BY columns, Vertica's sort key."""
        query = (
            "SELECT DISTINCT pc.table_column_name, pc.sort_position "
            "FROM v_catalog.projection_columns pc "
            "JOIN v_catalog.projections p ON p.projection_id = pc.projection_id "
            f"WHERE pc.table_schema = '{_quote_literal(self._schema)}' "
            f"AND pc.table_name = '{_quote_literal(self._table_name)}' "
            "AND p.is_super_projection AND pc.sort_position IS NOT NULL "
            "ORDER BY pc.sort_position"
        )
        try:
            rows = self._fetchall(self._conn.raw_sql(query))  # type: ignore[union-attr]
        except Exception:
            return []
        return self._filter_excluded_names([str(row[0]) for row in rows if row and row[0]])

    def indexes(self) -> str | None:
        """Describe how the table is physically laid out: partitioning and segmentation."""
        try:
            partition = self._fetchone(
                self._conn.raw_sql(  # type: ignore[union-attr]
                    "SELECT partition_expression FROM v_catalog.tables "
                    f"WHERE table_schema = '{_quote_literal(self._schema)}' "
                    f"AND table_name = '{_quote_literal(self._table_name)}'"
                )
            )
            segmentation = self._fetchone(
                self._conn.raw_sql(  # type: ignore[union-attr]
                    "SELECT segment_expression FROM v_catalog.projections "
                    f"WHERE projection_schema = '{_quote_literal(self._schema)}' "
                    f"AND anchor_table_name = '{_quote_literal(self._table_name)}' "
                    "AND is_super_projection AND is_segmented"
                )
            )
        except Exception:
            return None

        lines = []
        if partition and partition[0]:
            lines.append(f"PARTITION BY {str(partition[0]).strip()}")
        if segmentation and segmentation[0]:
            lines.append(f"SEGMENTED BY {str(segmentation[0]).strip()}")
        return "\n".join(lines) or None

    def _columns_sql(self) -> str:
        schema = _quote_literal(self._schema)
        table = _quote_literal(self._table_name)
        return (
            "SELECT column_name, data_type, is_nullable, ordinal_position "
            f"FROM v_catalog.columns WHERE table_schema = '{schema}' AND table_name = '{table}' "
            "UNION ALL "
            "SELECT column_name, data_type, TRUE, ordinal_position "
            f"FROM v_catalog.view_columns WHERE table_schema = '{schema}' AND table_name = '{table}' "
            "ORDER BY 4"
        )

    def _fetch_column_comments(self) -> dict[str, str]:
        query = (
            "SELECT child_object, comment FROM v_catalog.comments "
            "WHERE object_type = 'COLUMN' "
            f"AND object_schema = '{_quote_literal(self._schema)}' "
            f"AND object_name = '{_quote_literal(self._table_name)}'"
        )
        try:
            rows = self._fetchall(self._conn.raw_sql(query))  # type: ignore[union-attr]
        except Exception:
            return {}
        return {str(row[0]): str(row[1]).strip() for row in rows if row and row[0] and row[1]}

    @staticmethod
    def _format_type(data_type: str, is_nullable: bool) -> str:
        """Report the native Vertica type, flagging non-nullable columns like Redshift does."""
        normalized = data_type.strip()
        return normalized if is_nullable else f"{normalized} NOT NULL"

    def _quote(self, name: str) -> str:
        return _quote_identifier(name)

    def _cast_float(self, expr: str) -> str:
        return f"CAST({expr} AS FLOAT)"

    def _cast_complex_to_string(self, col_sql: str) -> str:
        """Vertica cannot cast ARRAY/ROW to VARCHAR, but TO_JSON renders both."""
        return f"TO_JSON({col_sql})"


class VerticaConfig(DatabaseConfig):
    """Vertica-specific configuration using the official vertica-python client."""

    type: Literal["vertica"] = "vertica"
    host: str = Field(description="Vertica host")
    port: int = Field(default=5433, description="Vertica port")
    database: str = Field(description="Database name")
    user: str = Field(description="Username")
    password: str = Field(default="", description="Password")
    schema_name: str | None = Field(
        default=None, description="Default schema (optional, syncs every non-system schema if not set)"
    )
    tlsmode: VerticaTlsMode = Field(
        default="require",
        description=(
            "TLS mode for the connection, same ladder as libpq's sslmode: "
            "'disable' never encrypts, 'prefer' encrypts when the server offers it, "
            "'require' encrypts but does not check the certificate, "
            "'verify-ca' also checks the server certificate against tls_cafile, and "
            "'verify-full' additionally checks that the certificate matches the host. "
            "Defaults to 'require' so a misconfigured server fails loudly instead of "
            "silently falling back to plaintext."
        ),
    )
    tls_cafile: str | None = Field(
        default=None,
        description=(
            "Path to a PEM certificate authority bundle used to verify the server certificate. "
            "Only read when tlsmode is 'verify-ca' or 'verify-full'; when unset those modes fall "
            "back to the system trust store."
        ),
    )
    tls_certfile: str | None = Field(
        default=None,
        description="Path to the client certificate, for servers that require mutual TLS. Needs tls_keyfile.",
    )
    tls_keyfile: str | None = Field(
        default=None,
        description="Path to the client private key, for servers that require mutual TLS. Needs tls_certfile.",
    )

    @model_validator(mode="after")
    def validate_tls(self) -> "VerticaConfig":
        if bool(self.tls_certfile) != bool(self.tls_keyfile):
            raise ValueError("tls_certfile and tls_keyfile must be provided together for mutual TLS")
        return self

    def tls_connection_options(self) -> dict[str, str]:
        """Map the TLS config fields onto vertica-python's connection options.

        Certificate paths are only forwarded when the mode actually verifies or
        presents them, so the driver never warns about options it would ignore.
        """
        options: dict[str, str] = {"tlsmode": self.tlsmode}
        if self.tlsmode in ("verify-ca", "verify-full") and self.tls_cafile:
            options["tls_cafile"] = self.tls_cafile
        if self.tlsmode != "disable" and self.tls_certfile and self.tls_keyfile:
            options["tls_certfile"] = self.tls_certfile
            options["tls_keyfile"] = self.tls_keyfile
        return options

    @classmethod
    def promptConfig(cls) -> "VerticaConfig":
        """Interactively prompt the user for Vertica configuration."""
        name = ask_text("Connection name:", default="vertica-prod") or "vertica-prod"
        host = ask_text("Host:", default="localhost") or "localhost"
        port_str = ask_text("Port:", default="5433") or "5433"

        if not port_str.isdigit():
            raise InitError("Port must be a valid integer.")

        database = ask_text("Database name:", required_field=True)
        user = ask_text("Username:", required_field=True)
        password = ask_text("Password:", password=True) or ""
        schema_name = ask_text("Default schema (syncs every non-system schema if empty):")
        tlsmode = ask_text(f"TLS mode ({', '.join(TLS_MODES)}):", default="require") or "require"

        if tlsmode not in TLS_MODES:
            raise InitError(f"TLS mode must be one of: {', '.join(TLS_MODES)}.")

        tls_cafile = None
        if tlsmode in ("verify-ca", "verify-full"):
            tls_cafile = ask_text("Path to the CA bundle (empty uses the system trust store):") or None

        tls_certfile = None
        tls_keyfile = None
        if tlsmode != "disable" and ask_confirm("Does the server require a client certificate?", default=False):
            tls_certfile = ask_text("Path to the client certificate:", required_field=True)
            tls_keyfile = ask_text("Path to the client private key:", required_field=True)

        return VerticaConfig(
            name=name,
            host=host,
            port=int(port_str),
            database=database or "",
            user=user or "",
            password=password,
            schema_name=schema_name or None,
            tlsmode=tlsmode,  # type: ignore[arg-type]
            tls_cafile=tls_cafile,
            tls_certfile=tls_certfile,
            tls_keyfile=tls_keyfile,
        )

    def connect(self):
        require_dependency("vertica_python", "vertica", "to connect to Vertica databases")
        import vertica_python

        conn = vertica_python.connect(
            host=self.host,
            port=self.port,
            database=self.database,
            user=self.user,
            password=self.password,
            autocommit=True,
            **self.tls_connection_options(),
        )
        return VerticaBackend(conn, self.schema_name or DEFAULT_SCHEMA)

    def get_database_name(self) -> str:
        """Get the database name for Vertica."""
        return self.database

    def get_schemas(self, conn) -> list[str]:
        if self.schema_name:
            return [self.schema_name]
        return conn.list_databases()

    def create_context(self, conn, schema: str, table_name: str) -> VerticaDatabaseContext:
        return VerticaDatabaseContext(conn, schema, table_name, exclude_columns=self.exclude_columns)

    def get_query_history_dialect(self) -> str | None:
        """sqlglot has no Vertica dialect; Postgres parses Vertica's syntax closely enough."""
        return "postgres"

    def _default_query_history_sql(self, days: int) -> str | None:
        """Read recent requests from Vertica's monitoring view, skipping nao's own session."""
        return (
            "SELECT request AS query_text "
            "FROM v_monitor.query_requests "
            f"WHERE start_timestamp >= (CURRENT_TIMESTAMP - INTERVAL '{int(days)} days') "
            "AND request_type = 'QUERY' "
            "AND success "
            "AND session_id <> current_session() "
            "ORDER BY start_timestamp DESC "
            "LIMIT 10000"
        )

    def check_connection(self) -> tuple[bool, str]:
        conn = None
        try:
            conn = self.connect()
            schemas = self.get_schemas(conn)
            tables = []
            for schema in schemas:
                tables.extend(conn.list_tables(database=schema))
            return True, f"Connected successfully ({len(tables)} tables found)"
        except Exception as e:
            return False, str(e)
        finally:
            if conn is not None:
                conn.disconnect()
