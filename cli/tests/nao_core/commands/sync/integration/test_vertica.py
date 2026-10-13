"""Integration tests for the database sync pipeline against a real Vertica database.

Connection is configured via environment variables:
    VERTICA_HOST, VERTICA_PORT (default 5433), VERTICA_DATABASE,
    VERTICA_USER, VERTICA_PASSWORD, VERTICA_TLSMODE (default require),
    VERTICA_TLS_CAFILE (path to the server's CA bundle).

docker-compose.test.yml starts Vertica with server TLS enabled and publishes the
CA certificate it mints, so the TLS ladder is exercised against a real encrypted
connection rather than mocked.

A Vertica cluster holds exactly one database, so the fixtures below create two
throwaway schemas instead of a throwaway database.

The test suite is skipped entirely when VERTICA_HOST is not set.
"""

import os
import uuid
from pathlib import Path

import pytest
from rich.progress import Progress

from nao_core.commands.sync.providers.databases.provider import sync_database
from nao_core.config.databases.vertica import VerticaConfig

from .base import BaseSyncIntegrationTests, SyncTestSpec

VERTICA_HOST = os.environ.get("VERTICA_HOST")

pytestmark = pytest.mark.skipif(
    VERTICA_HOST is None, reason="VERTICA_HOST not set — skipping Vertica integration tests"
)


TLSMODE = os.environ.get("VERTICA_TLSMODE", "require")
TLS_CAFILE = os.environ.get("VERTICA_TLS_CAFILE") or None


def _connect():
    return _config_with().connect()._conn


def _config_with(**overrides) -> VerticaConfig:
    """Build a VerticaConfig for the live server, overriding individual fields."""
    settings = {
        "name": "test-vertica",
        "host": os.environ["VERTICA_HOST"],
        "port": int(os.environ.get("VERTICA_PORT", "5433")),
        "database": os.environ["VERTICA_DATABASE"],
        "user": os.environ["VERTICA_USER"],
        "password": os.environ.get("VERTICA_PASSWORD", ""),
        "tlsmode": TLSMODE,
        "tls_cafile": TLS_CAFILE,
    }
    settings.update(overrides)
    return VerticaConfig.model_validate(settings)


@pytest.fixture(scope="module")
def unrelated_ca_file(tmp_path_factory):
    """Mint a certificate authority that did not sign the server certificate."""
    from datetime import datetime, timedelta, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "nao-vertica-unrelated-ca")])
    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    path = tmp_path_factory.mktemp("vertica_tls") / "unrelated-ca.crt"
    path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return str(path)


@pytest.fixture(scope="module")
def temp_schemas():
    """Create two temporary schemas populated with test data, then drop them."""
    primary = f"nao_unit_tests_{uuid.uuid4().hex[:8].lower()}"
    another = f"{primary}_another"

    sql_file = Path(__file__).parent / "dml" / "vertica.sql"
    sql_content = sql_file.read_text().replace("{schema}", primary).replace("{another_schema}", another)

    conn = _connect()
    try:
        cursor = conn.cursor()
        for statement in sql_content.split(";"):
            statement = statement.strip()
            if statement:
                cursor.execute(statement)

        yield {"primary": primary, "another": another}
    finally:
        cleanup = _connect()
        cleanup_cursor = cleanup.cursor()
        for schema in (another, primary):
            try:
                cleanup_cursor.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            except Exception:
                pass
        cleanup.close()
        conn.close()


@pytest.fixture(scope="module")
def db_config(temp_schemas):
    """Build a VerticaConfig from environment variables using the temporary schema."""
    return _config_with(schema_name=temp_schemas["primary"])


@pytest.fixture(scope="module")
def spec(temp_schemas):
    return SyncTestSpec(
        db_type="vertica",
        primary_schema=temp_schemas["primary"],
        users_column_assertions=(
            "# users",
            f"**Dataset:** `{temp_schemas['primary']}`",
            "## Columns (4)",
            "- id (int NOT NULL)",
            "- name (varchar(255) NOT NULL)",
            '"User email address"',
            "- active (boolean)",
        ),
        orders_column_assertions=(
            "# orders",
            f"**Dataset:** `{temp_schemas['primary']}`",
            "## Columns (3)",
            "- id (int NOT NULL)",
            "- user_id (int NOT NULL)",
            "- amount (float NOT NULL)",
        ),
        users_table_description="Registered user accounts",
        sort_rows=True,
        users_preview_rows=[
            {"id": 1, "name": "Alice", "email": "alice@example.com", "active": True},
            {"id": 2, "name": "Bob", "email": None, "active": False},
            {"id": 3, "name": "Charlie", "email": "charlie@example.com", "active": True},
        ],
        orders_preview_rows=[
            {"id": 1, "user_id": 1, "amount": 99.99},
            {"id": 2, "user_id": 1, "amount": 24.5},
        ],
        users_profiling_rows=[
            {
                "column": "id",
                "type": "int",
                "total_count": 3,
                "null_count": 0,
                "null_percentage": 0.0,
                "distinct_count": 3,
                "min": 1,
                "max": 3,
                "mean": 2.0,
                "stddev": 0.8165,
            },
            {
                "column": "name",
                "type": "varchar(255)",
                "total_count": 3,
                "null_count": 0,
                "null_percentage": 0.0,
                "distinct_count": 3,
                "top_values": [
                    {"value": "Alice", "count": 1},
                    {"value": "Bob", "count": 1},
                    {"value": "Charlie", "count": 1},
                ],
            },
            {
                "column": "email",
                "type": "varchar(255)",
                "total_count": 3,
                "null_count": 1,
                "null_percentage": 33.33,
                "distinct_count": 2,
                "top_values": [
                    {"value": "alice@example.com", "count": 1},
                    {"value": "charlie@example.com", "count": 1},
                ],
            },
            {
                "column": "active",
                "type": "boolean",
                "total_count": 3,
                "null_count": 0,
                "null_percentage": 0.0,
                "distinct_count": 2,
                "top_values": [{"value": True, "count": 2}, {"value": False, "count": 1}],
            },
        ],
        orders_profiling_rows=[
            {
                "column": "id",
                "type": "int",
                "total_count": 2,
                "null_count": 0,
                "null_percentage": 0.0,
                "distinct_count": 2,
                "min": 1,
                "max": 2,
                "mean": 1.5,
                "stddev": 0.5,
            },
            {
                "column": "user_id",
                "type": "int",
                "total_count": 2,
                "null_count": 0,
                "null_percentage": 0.0,
                "distinct_count": 1,
                "top_values": [{"value": 1, "count": 2}],
            },
            {
                "column": "amount",
                "type": "float",
                "total_count": 2,
                "null_count": 0,
                "null_percentage": 0.0,
                "distinct_count": 2,
                "min": 24.5,
                "max": 99.99,
                "mean": 62.245,
                "stddev": 37.745,
            },
        ],
        schema_field="schema_name",
        another_schema=temp_schemas["another"],
        another_table="whatever",
    )


class TestVerticaSyncIntegration(BaseSyncIntegrationTests):
    """Verify the sync pipeline produces correct output against a live Vertica database."""

    def test_query_history_md_users(self, synced, spec):
        """Override base expectation: Vertica's monitoring view holds real history.

        Every other provider either has no query history source or an empty one,
        so the base class asserts the "no history" branch. v_monitor.query_requests
        is populated as soon as the fixture inserts its rows, so the sync finds
        genuine usage for the fixture tables.
        """
        _, output, config = synced
        content = self._read_table_file(output, config, spec, spec.users_table, "query_history.md")

        assert "_No query history found for this table._" not in content
        assert "This table was referenced in" in content

    def test_query_history_md_orders(self, synced, spec):
        """Override base expectation: see test_query_history_md_users."""
        _, output, config = synced
        content = self._read_table_file(output, config, spec, spec.orders_table, "query_history.md")

        assert "_No query history found for this table._" not in content
        assert "This table was referenced in" in content

    # ── TLS ───────────────────────────────────────────────────────────────────

    def test_require_opens_an_encrypted_connection(self, db_config):
        """tlsmode='require' must actually encrypt, not silently fall back."""
        config = db_config.model_copy(update={"tlsmode": "require", "tls_cafile": None})
        backend = config.connect()
        try:
            assert backend._conn.ssl() is True
            assert int(backend.raw_sql("SELECT COUNT(*) FROM v_catalog.schemata").fetchone()[0]) > 0
        finally:
            backend.disconnect()

    def test_disable_opens_a_plaintext_connection(self, db_config):
        config = db_config.model_copy(update={"tlsmode": "disable", "tls_cafile": None})
        backend = config.connect()
        try:
            assert backend._conn.ssl() is False
        finally:
            backend.disconnect()

    @pytest.mark.parametrize("mode", ["verify-ca", "verify-full"])
    def test_verifying_modes_accept_the_servers_own_ca(self, db_config, mode):
        if not TLS_CAFILE:
            pytest.skip("VERTICA_TLS_CAFILE not set — cannot verify the server certificate")

        config = db_config.model_copy(update={"tlsmode": mode, "tls_cafile": TLS_CAFILE})
        backend = config.connect()
        try:
            assert backend._conn.ssl() is True
        finally:
            backend.disconnect()

    def test_verify_ca_rejects_an_unrelated_certificate_authority(self, db_config, unrelated_ca_file):
        """The negative case that proves verification is enforced rather than ignored."""
        config = db_config.model_copy(update={"tlsmode": "verify-ca", "tls_cafile": unrelated_ca_file})

        with pytest.raises(Exception) as excinfo:
            config.connect()

        assert "CERTIFICATE_VERIFY_FAILED" in str(excinfo.value)

    def test_verify_ca_rejects_the_server_when_no_ca_is_trusted(self, db_config):
        """Without a CA bundle the self-signed test certificate is not in the system trust store."""
        config = db_config.model_copy(update={"tlsmode": "verify-ca", "tls_cafile": None})

        with pytest.raises(Exception) as excinfo:
            config.connect()

        assert "CERTIFICATE_VERIFY_FAILED" in str(excinfo.value)

    def test_verify_full_rejects_a_host_absent_from_the_certificate(self, db_config):
        """verify-full checks the hostname; verify-ca against the same address does not.

        127.0.0.1 is routable on every platform but absent from the certificate,
        which names DNS:localhost only. 127.0.0.2 would need Linux's whole
        127.0.0.0/8 loopback range, which macOS does not bind.
        """
        if not TLS_CAFILE:
            pytest.skip("VERTICA_TLS_CAFILE not set — cannot verify the server certificate")
        if db_config.host not in ("localhost", "127.0.0.1"):
            pytest.skip("Host-mismatch check only applies to the loopback test server")

        unlisted_host = "127.0.0.1"
        verify_ca = db_config.model_copy(
            update={"host": unlisted_host, "tlsmode": "verify-ca", "tls_cafile": TLS_CAFILE}
        )
        backend = verify_ca.connect()
        try:
            assert backend._conn.ssl() is True
        finally:
            backend.disconnect()

        verify_full = db_config.model_copy(
            update={"host": unlisted_host, "tlsmode": "verify-full", "tls_cafile": TLS_CAFILE}
        )
        with pytest.raises(Exception) as excinfo:
            verify_full.connect()

        assert "not valid for" in str(excinfo.value)

    def test_check_connection_reports_a_tls_failure_clearly(self, db_config):
        """A TLS problem must surface through check_connection rather than look like success."""
        config = db_config.model_copy(update={"tlsmode": "verify-ca", "tls_cafile": None})

        ok, message = config.check_connection()

        assert ok is False
        assert "CERTIFICATE_VERIFY_FAILED" in message

    def test_sync_runs_over_a_verified_tls_connection(self, tmp_path_factory, db_config, spec):
        """End-to-end proof that the whole sync pipeline works over verified TLS."""
        if not TLS_CAFILE:
            pytest.skip("VERTICA_TLS_CAFILE not set — cannot verify the server certificate")

        config = db_config.model_copy(update={"tlsmode": "verify-full", "tls_cafile": TLS_CAFILE})

        output = tmp_path_factory.mktemp("vertica_tls_sync")
        with Progress(transient=True) as progress:
            state = sync_database(config, output, progress)

        assert state.tables_synced == spec.primary_table_count
        base = self._base_path(output, config, spec)
        assert (base / f"table={spec.users_table}" / "columns.md").exists()

    def test_clustering_columns_report_the_projection_sort_order(self, db_config, spec):
        """Vertica's super projection sort order is the equivalent of a Redshift SORTKEY."""
        conn = db_config.connect()
        try:
            context = db_config.create_context(conn, spec.primary_schema, spec.users_table)
            assert context.clustering_columns() == ["id", "name", "email", "active"]
        finally:
            conn.disconnect()

    def test_views_are_synced_with_their_columns(self, tmp_path_factory, db_config, spec):
        """Views live in v_catalog.view_columns, not v_catalog.columns."""
        conn = db_config.connect()
        try:
            conn.raw_sql(
                f'CREATE OR REPLACE VIEW "{spec.primary_schema}"."active_users" '
                f'AS SELECT id, name FROM "{spec.primary_schema}"."users" WHERE active'
            )
            assert "active_users" in conn.list_tables(database=spec.primary_schema)

            context = db_config.create_context(conn, spec.primary_schema, "active_users")
            columns = context.columns()
            assert [column["name"] for column in columns] == ["id", "name"]
            assert columns[0]["type"] == "int"
        finally:
            conn.raw_sql(f'DROP VIEW IF EXISTS "{spec.primary_schema}"."active_users"')
            conn.disconnect()
