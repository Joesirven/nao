import ssl
import sys
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from nao_core.config.databases import parse_database_config
from nao_core.config.databases.column_access import _SQLGLOT_DIALECTS as COLUMN_ACCESS_DIALECTS
from nao_core.config.databases.query_guard import (
    _CASE_INSENSITIVE_IDENTIFIER_TYPES as CASE_INSENSITIVE_IDENTIFIER_TYPES,
)
from nao_core.config.databases.query_guard import SQLGLOT_DIALECTS
from nao_core.config.databases.vertica import VerticaBackend, VerticaConfig, VerticaDatabaseContext


def _config(**overrides: object) -> VerticaConfig:
    return VerticaConfig.model_validate(
        {
            "name": "vertica",
            "host": "vertica.example",
            "database": "analytics",
            "user": "alice",
            "password": "secret",
            **overrides,
        }
    )


def _conn_returning(rows: list[tuple]) -> MagicMock:
    """A mock standing in for a nao backend, whose contract is raw_sql()."""
    conn = MagicMock()
    cursor = MagicMock()
    cursor.fetchall.return_value = rows
    cursor.fetchone.return_value = rows[0] if rows else None
    conn.raw_sql.return_value = cursor
    return conn


def _backend_returning(rows: list[tuple]) -> tuple[VerticaBackend, MagicMock]:
    """A real VerticaBackend over a mock vertica-python connection."""
    cursor = MagicMock()
    cursor.fetchall.return_value = rows
    cursor.fetchone.return_value = rows[0] if rows else None
    conn = MagicMock()
    conn.cursor.return_value = cursor
    return VerticaBackend(conn, "public"), cursor


def test_parses_from_config_dict():
    config = parse_database_config(
        {
            "type": "vertica",
            "name": "vertica",
            "host": "vertica.example",
            "database": "analytics",
            "user": "alice",
            "password": "secret",
        }
    )

    assert isinstance(config, VerticaConfig)
    assert config.port == 5433
    assert config.tlsmode == "require"
    assert config.get_database_name() == "analytics"


def test_get_schemas_returns_configured_schema_without_querying():
    conn = MagicMock()

    assert _config(schema_name="marts").get_schemas(conn) == ["marts"]
    conn.raw_sql.assert_not_called()


def test_get_schemas_skips_system_schemas():
    backend, cursor = _backend_returning([("public",), ("marts",)])

    assert _config().get_schemas(backend) == ["public", "marts"]
    sql = " ".join(cursor.execute.call_args.args[0].split())
    assert "FROM v_catalog.schemata" in sql
    assert "WHERE NOT is_system_schema" in sql


def test_list_tables_includes_views():
    backend, cursor = _backend_returning([("orders",), ("users",), ("active_users",)])

    assert backend.list_tables("marts") == ["orders", "users", "active_users"]
    sql = " ".join(cursor.execute.call_args.args[0].split())
    assert "FROM v_catalog.tables WHERE table_schema = 'marts'" in sql
    assert "FROM v_catalog.views WHERE table_schema = 'marts'" in sql


def test_list_tables_falls_back_to_the_default_schema():
    backend, cursor = _backend_returning([("users",)])

    backend.list_tables()

    assert "table_schema = 'public'" in cursor.execute.call_args.args[0]


def test_list_tables_escapes_a_quote_in_the_schema_name():
    backend, cursor = _backend_returning([])

    backend.list_tables("we'ird")

    assert "table_schema = 'we''ird'" in cursor.execute.call_args.args[0]


def test_table_comments_issue_one_query_for_the_whole_schema():
    """v_catalog.comments pays a flat, cluster-wide cost per call, so a 20-table
    sync issuing it once per table rather than once per schema costs half an hour
    of nothing but metadata."""
    backend, cursor = _backend_returning(
        [
            ("TABLE", "users", None, "Registered user accounts"),
            ("COLUMN", "users", "email", "User email address"),
            ("TABLE", "orders", None, "Customer orders"),
        ]
    )

    assert backend.table_comments("marts") == {"users": "Registered user accounts", "orders": "Customer orders"}
    assert backend.table_comments("marts") == {"users": "Registered user accounts", "orders": "Customer orders"}

    assert cursor.execute.call_count == 1
    sql = " ".join(cursor.execute.call_args.args[0].split())
    assert "FROM v_catalog.comments" in sql
    assert "object_schema = 'marts'" in sql


def test_column_comments_share_the_table_comments_cache():
    backend, cursor = _backend_returning(
        [
            ("TABLE", "users", None, "Registered user accounts"),
            ("COLUMN", "users", "email", "User email address"),
        ]
    )

    assert backend.column_comments("marts", "users") == {"email": "User email address"}
    assert backend.table_comments("marts") == {"users": "Registered user accounts"}

    assert cursor.execute.call_count == 1


def test_comments_do_not_requery_for_a_second_table_in_the_same_schema():
    backend, cursor = _backend_returning([("TABLE", "users", None, "Registered user accounts")])

    backend.table_comments("marts")
    backend.column_comments("marts", "users")
    backend.column_comments("marts", "orders")

    assert cursor.execute.call_count == 1


def test_comments_requery_for_a_different_schema():
    backend, cursor = _backend_returning([("TABLE", "users", None, "Registered user accounts")])

    backend.table_comments("marts")
    backend.table_comments("analytics")

    assert cursor.execute.call_count == 2


def test_comments_fetch_failure_is_cached_as_empty_rather_than_retried():
    backend, cursor = _backend_returning([])
    cursor.execute.side_effect = RuntimeError("catalog unavailable")

    assert backend.table_comments("marts") == {}
    assert backend.column_comments("marts", "users") == {}

    assert cursor.execute.call_count == 1


def test_clustering_columns_issue_one_query_for_the_whole_schema():
    backend, cursor = _backend_returning(
        [
            ("users", "id", 1),
            ("users", "created_at", 2),
            ("orders", "id", 1),
        ]
    )

    assert backend.clustering_columns("marts", "users") == ["id", "created_at"]
    assert backend.clustering_columns("marts", "orders") == ["id"]

    assert cursor.execute.call_count == 1
    sql = " ".join(cursor.execute.call_args.args[0].split())
    assert "FROM v_catalog.projection_columns" in sql
    assert "JOIN v_catalog.projections" in sql
    assert "table_schema = 'marts'" in sql


def test_clustering_columns_do_not_requery_for_a_second_table_in_the_same_schema():
    backend, cursor = _backend_returning([("users", "id", 1)])

    backend.clustering_columns("marts", "users")
    backend.clustering_columns("marts", "orders")

    assert cursor.execute.call_count == 1


def test_clustering_columns_fetch_failure_is_cached_as_empty_rather_than_retried():
    backend, cursor = _backend_returning([])
    cursor.execute.side_effect = RuntimeError("catalog unavailable")

    assert backend.clustering_columns("marts", "users") == []
    assert backend.clustering_columns("marts", "orders") == []

    assert cursor.execute.call_count == 1


def test_columns_reads_both_table_and_view_catalogs_and_attaches_comments():
    conn = MagicMock()
    conn.column_comments.return_value = {"email": "User email address"}
    column_cursor = MagicMock()
    column_cursor.fetchall.return_value = [
        ("id", "int", False, 1),
        ("email", "varchar(255)", True, 2),
    ]
    conn.raw_sql.return_value = column_cursor

    context = VerticaDatabaseContext(conn, "marts", "users")

    assert context.columns() == [
        {"name": "id", "type": "int NOT NULL", "nullable": False, "description": None},
        {"name": "email", "type": "varchar(255)", "nullable": True, "description": "User email address"},
    ]
    conn.column_comments.assert_called_once_with("marts", "users")
    column_sql = " ".join(conn.raw_sql.call_args.args[0].split())
    assert "FROM v_catalog.columns" in column_sql
    assert "FROM v_catalog.view_columns" in column_sql


def test_description_reads_the_table_comment():
    conn = MagicMock()
    conn.table_comments.return_value = {"users": "Registered user accounts"}
    context = VerticaDatabaseContext(conn, "marts", "users")

    assert context.description() == "Registered user accounts"
    conn.table_comments.assert_called_once_with("marts")


def test_description_is_none_when_the_table_has_no_comment():
    conn = MagicMock()
    conn.table_comments.return_value = {}

    assert VerticaDatabaseContext(conn, "marts", "users").description() is None


def test_clustering_columns_delegates_to_the_backends_schema_wide_cache():
    conn = MagicMock()
    conn.clustering_columns.return_value = ["id", "created_at"]

    assert VerticaDatabaseContext(conn, "marts", "users").clustering_columns() == ["id", "created_at"]
    conn.clustering_columns.assert_called_once_with("marts", "users")


def test_identifiers_are_double_quoted_and_escaped():
    context = VerticaDatabaseContext(MagicMock(), 'we"ird', "users")

    assert context._quote('a"b') == '"a""b"'
    assert context._qualified_table_sql() == '"we""ird"."users"'


def test_complex_types_are_stringified_with_to_json():
    """Vertica cannot cast ARRAY or ROW to VARCHAR, so profiling needs TO_JSON."""
    context = VerticaDatabaseContext(MagicMock(), "marts", "events")

    assert context._cast_complex_to_string('"payload"') == 'TO_JSON("payload")'
    assert context._cast_float('"amount"') == 'CAST("amount" AS FLOAT)'


def test_exclude_columns_hide_columns_from_the_context():
    conn = MagicMock()
    conn.column_comments.return_value = {}
    column_cursor = MagicMock()
    column_cursor.fetchall.return_value = [("id", "int", False, 1), ("email", "varchar(255)", True, 2)]
    conn.raw_sql.return_value = column_cursor

    config = _config(exclude_columns=["*.*.email"])
    context = config.create_context(conn, "marts", "users")

    assert [column["name"] for column in context.columns()] == ["id"]


def test_query_history_sql_targets_the_monitoring_view_and_skips_its_own_session():
    sql = " ".join((_config().get_query_history_sql(7) or "").split())

    assert "FROM v_monitor.query_requests" in sql
    assert "request AS query_text" in sql
    assert "INTERVAL '7 days'" in sql
    assert "session_id <> current_session()" in sql


def test_query_history_sql_honours_a_custom_override():
    config = _config(query_history_sql="SELECT request AS query_text FROM my_audit WHERE days = {days}")

    assert config.get_query_history_sql(3) == "SELECT request AS query_text FROM my_audit WHERE days = 3"


def test_query_history_is_parsed_with_the_postgres_dialect():
    """sqlglot has no Vertica dialect, so an unmapped type would silently lose every reference."""
    assert "vertica" not in __import__("sqlglot").dialects.dialect.Dialect.classes
    assert _config().get_query_history_dialect() == "postgres"


def test_registered_in_every_sqlglot_dialect_map_the_guards_consult():
    """Each guard refuses a type it cannot map to a dialect, so both maps must carry vertica.

    allow_listed_only_guard, exclude_columns_guard and row_security_guard read
    query_guard.SQLGLOT_DIALECTS; column_access keeps its own copy.
    """
    assert SQLGLOT_DIALECTS["vertica"] == "postgres"
    assert COLUMN_ACCESS_DIALECTS["vertica"] == "postgres"


def test_identifiers_are_matched_case_insensitively_by_the_query_guard():
    """Vertica folds nothing but compares unquoted identifiers without regard to case."""
    assert "vertica" in CASE_INSENSITIVE_IDENTIFIER_TYPES


@pytest.mark.parametrize("mode", ["disable", "prefer", "require", "verify-ca", "verify-full"])
def test_accepts_every_documented_tls_mode(mode):
    assert _config(tlsmode=mode).tlsmode == mode


def test_defaults_to_require_so_plaintext_is_never_a_silent_fallback():
    assert _config().tlsmode == "require"


def test_rejects_an_unknown_tls_mode():
    with pytest.raises(ValidationError):
        _config(tlsmode="sslv3-please")


@pytest.mark.parametrize("mode", ["verify-ca", "verify-full"])
def test_verifying_modes_forward_the_ca_bundle(mode):
    options = _config(tlsmode=mode, tls_cafile="/etc/ssl/vertica-ca.pem").tls_connection_options()

    assert options == {"tlsmode": mode, "tls_cafile": "/etc/ssl/vertica-ca.pem"}


@pytest.mark.parametrize("mode", ["disable", "prefer", "require"])
def test_non_verifying_modes_drop_the_ca_bundle(mode):
    """vertica-python warns about certificate files it would ignore, so they are not sent."""
    options = _config(tlsmode=mode, tls_cafile="/etc/ssl/vertica-ca.pem").tls_connection_options()

    assert options == {"tlsmode": mode}


@pytest.mark.parametrize("mode", ["verify-ca", "verify-full"])
def test_verifying_without_a_ca_bundle_falls_back_to_the_system_trust_store(mode):
    """vertica-python's own context-building only loads a trust store when a cafile
    is given, leaving verify-ca/verify-full with zero trust anchors otherwise.
    ssl.create_default_context() is what actually loads the platform trust store.
    """
    options = _config(tlsmode=mode).tls_connection_options()

    assert options.keys() == {"ssl"}
    context = options["ssl"]
    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.cert_store_stats()["x509_ca"] > 0


@pytest.mark.parametrize("mode", ["verify-ca", "verify-full"])
def test_check_hostname_follows_the_mode_without_a_ca_bundle(mode):
    context = _config(tlsmode=mode).tls_connection_options()["ssl"]

    assert context.check_hostname == (mode == "verify-full")


def _self_signed_cert_and_key(tmp_path):
    """Write a throwaway self-signed certificate and key, for load_cert_chain()."""
    from datetime import datetime, timedelta, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "nao-vertica-test-client")])
    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )

    certfile = tmp_path / "client.crt"
    keyfile = tmp_path / "client.key"
    certfile.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    keyfile.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return str(certfile), str(keyfile)


def test_mutual_tls_without_a_ca_bundle_still_loads_the_client_certificate(tmp_path):
    certfile, keyfile = _self_signed_cert_and_key(tmp_path)

    context = _config(tlsmode="verify-full", tls_certfile=certfile, tls_keyfile=keyfile).tls_connection_options()["ssl"]

    assert context.cert_store_stats()["x509_ca"] > 0


def test_mutual_tls_forwards_the_client_certificate_and_key():
    options = _config(
        tlsmode="verify-full",
        tls_cafile="/ca.pem",
        tls_certfile="/client.crt",
        tls_keyfile="/client.key",
    ).tls_connection_options()

    assert options == {
        "tlsmode": "verify-full",
        "tls_cafile": "/ca.pem",
        "tls_certfile": "/client.crt",
        "tls_keyfile": "/client.key",
    }


def test_mutual_tls_is_dropped_when_tls_is_disabled():
    options = _config(tlsmode="disable", tls_certfile="/client.crt", tls_keyfile="/client.key").tls_connection_options()

    assert options == {"tlsmode": "disable"}


@pytest.mark.parametrize(
    "overrides",
    [{"tls_certfile": "/client.crt"}, {"tls_keyfile": "/client.key"}],
)
def test_client_certificate_and_key_must_be_provided_together(overrides):
    with pytest.raises(ValidationError, match="must be provided together"):
        _config(**overrides)


def test_connect_passes_the_tls_options_to_the_driver():
    config = _config(tlsmode="verify-ca", tls_cafile="/ca.pem")
    driver = MagicMock()

    with patch.dict(sys.modules, {"vertica_python": driver}):
        config.connect()

    kwargs = driver.connect.call_args.kwargs
    assert kwargs["tlsmode"] == "verify-ca"
    assert kwargs["tls_cafile"] == "/ca.pem"
    assert kwargs["host"] == "vertica.example"
    assert kwargs["port"] == 5433
    assert kwargs["autocommit"] is True
    assert "tls_certfile" not in kwargs


def test_check_connection_reports_the_failure_reason():
    config = _config(host="nope.invalid")

    ok, message = config.check_connection()

    assert ok is False
    assert message
