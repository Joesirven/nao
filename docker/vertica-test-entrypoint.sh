#!/usr/bin/env bash
# Boots a single-node Vertica Community Edition database for the sync integration
# tests, with server TLS enabled so the adapter's tlsmode ladder can be exercised.
#
# The image OpenText publishes for Kubernetes carries no admintools, so the
# database is created with bootstrap-catalog and started with the server binary
# directly. Vertica refuses to run as root, hence the runuser calls.
set -euo pipefail

CATALOG=/vdata/catalog/vdb/v_vdb_node0001_catalog
CERT_DIR=/vdata/certs
CA_OUTPUT_DIR=/certs

as_dbadmin() {
	runuser -u dbadmin -- "$@"
}

vsql() {
	as_dbadmin /opt/vertica/bin/vsql -U dbadmin -d vdb "$@"
}

prepare_host() {
	id -u dbadmin > /dev/null 2>&1 || useradd -u 5000 -m dbadmin
	mkdir -p /vdata/catalog /vdata/data
	chown -R dbadmin:dbadmin /vdata
}

create_database_if_missing() {
	if [ -d "$CATALOG" ]; then
		return
	fi
	as_dbadmin /opt/vertica/bin/bootstrap-catalog \
		-D "$CATALOG" -C vdb -n v_vdb_node0001 \
		-H 127.0.0.1 -p 5433 -S /vdata/data/vdb \
		-L /opt/vertica/config/licensing/vertica_community_edition.license.key \
		-U dbadmin -A trust -N 1
}

start_database() {
	as_dbadmin /opt/vertica/bin/vertica \
		-D "$CATALOG" -C vdb -n v_vdb_node0001 -h 0.0.0.0 -p 5433 -4
}

wait_until_accepting_queries() {
	for _ in $(seq 1 60); do
		if vsql -c 'SELECT 1' > /dev/null 2>&1; then
			return 0
		fi
		sleep 2
	done
	echo 'vertica did not start accepting queries' >&2
	return 1
}

# Mints a throwaway certificate authority and a server certificate for localhost,
# once per volume. The private keys stay inside the container; only the CA
# certificate is published, so the tests on the host can point tls_cafile at it.
generate_certificates() {
	if [ -f "$CERT_DIR/ca.crt" ] && [ -f "$CERT_DIR/server.crt" ] && [ -f "$CERT_DIR/server.key" ]; then
		return
	fi
	rm -rf "$CERT_DIR"
	mkdir -p "$CERT_DIR"
	openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 \
		-subj '/CN=nao-vertica-test-ca' \
		-keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" 2> /dev/null
	openssl req -new -nodes -newkey rsa:2048 \
		-subj '/CN=localhost' \
		-keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" 2> /dev/null
	printf 'subjectAltName=DNS:localhost,DNS:nao_test_vertica,IP:127.0.0.1\n' > "$CERT_DIR/san.cnf"
	openssl x509 -req -in "$CERT_DIR/server.csr" \
		-CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
		-days 3650 -out "$CERT_DIR/server.crt" -extfile "$CERT_DIR/san.cnf" 2> /dev/null
	chown -R dbadmin:dbadmin "$CERT_DIR"
}

enable_server_tls() {
	local sql="$CERT_DIR/enable-tls.sql"
	{
		echo "ALTER TLS CONFIGURATION server CERTIFICATE NULL TLSMODE 'DISABLE';"
		echo 'DROP CERTIFICATE IF EXISTS nao_server_cert CASCADE;'
		echo 'DROP CERTIFICATE IF EXISTS nao_test_ca CASCADE;'
		echo 'DROP KEY IF EXISTS nao_server_key CASCADE;'
		printf "CREATE KEY nao_server_key TYPE 'RSA' AS \$\$%s\$\$;\n" "$(cat "$CERT_DIR/server.key")"
		printf "CREATE CA CERTIFICATE nao_test_ca AS \$\$%s\$\$;\n" "$(cat "$CERT_DIR/ca.crt")"
		printf "CREATE CERTIFICATE nao_server_cert AS \$\$%s\$\$ KEY nao_server_key;\n" "$(cat "$CERT_DIR/server.crt")"
		echo "ALTER TLS CONFIGURATION server CERTIFICATE nao_server_cert TLSMODE 'ENABLE';"
	} > "$sql"
	chown dbadmin:dbadmin "$sql"
	vsql -v ON_ERROR_STOP=1 -f "$sql" > /dev/null
}

publish_ca_certificate() {
	if [ ! -d "$CA_OUTPUT_DIR" ]; then
		return
	fi
	install -m 644 "$CERT_DIR/ca.crt" "$CA_OUTPUT_DIR/ca.crt"
}

# Keeps PID 1 alive for exactly as long as the database is up: the server binary
# daemonises itself, so there is no foreground process to wait on.
supervise_database() {
	while as_dbadmin /opt/vertica/bin/vertica -D "$CATALOG" -s > /dev/null 2>&1; do
		sleep 10
	done
	echo 'vertica is no longer running' >&2
}

prepare_host
create_database_if_missing
start_database
wait_until_accepting_queries
generate_certificates
enable_server_tls
publish_ca_certificate
echo 'vertica is ready with server TLS enabled'
supervise_database
