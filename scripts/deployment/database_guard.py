"""Read-only identity binding. Unsupported/unverifiable connections fail closed.

Only an existing direct libpq connection to a Cloud SQL per-instance CA endpoint
is accepted. No proxy startup, certificate issuance, GRANT or configuration write.
"""
from decimal import Decimal, ROUND_CEILING
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def database_target(instance, project, instance_name, database_name):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,62}", database_name):
        raise RuntimeError("A plain, unambiguous database name is required")
    connection = f"{project}:{instance.get('region')}:{instance_name}"
    if (instance.get("project") != project or instance.get("name") != instance_name
            or instance.get("connectionName") != connection or not instance.get("region")
            or instance.get("instanceType") != "CLOUD_SQL_INSTANCE" or instance.get("state") != "RUNNABLE"
            or not instance.get("databaseVersion", "").startswith("POSTGRES_") or not instance.get("createTime")):
        raise RuntimeError("Cloud SQL instance identity is incomplete or does not match the backup target")
    mode = instance.get("settings", {}).get("ipConfiguration", {}).get("serverCaMode")
    # Google documents unspecified mode as the dedicated per-instance CA.
    if mode not in (None, "CA_MODE_UNSPECIFIED", "GOOGLE_MANAGED_INTERNAL_CA"):
        raise RuntimeError("Shared/customer CA identity is not supported; do not change the instance to bypass this guard")
    certificate = instance.get("serverCaCert", {}).get("cert", "")
    try:
        # A single instance-specific trust anchor, never a local/shared CA bundle.
        if certificate.count("-----BEGIN CERTIFICATE-----") != 1 or certificate.count("-----END CERTIFICATE-----") != 1:
            raise ValueError()
        der = ssl.PEM_cert_to_DER_cert(certificate)
        addresses = sorted({str(ipaddress.ip_address(row["ipAddress"])) for row in instance.get("ipAddresses", [])
                            if row.get("type") in ("PRIMARY", "PRIVATE") and not row.get("timeToRetire")})
        if not addresses or not der:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("Cloud SQL certificate/address identity is unavailable") from None
    summary = {"connection_name": connection, "database": database_name, "created_at": instance["createTime"],
               "server_ca_sha256": hashlib.sha256(der).hexdigest(), "addresses_sha256": fingerprint(addresses)}
    return {"summary": summary, "addresses": addresses, "certificate": certificate}


def assert_run_database(spec, target):
    """Validate the app's actual socket precedence and its Cloud Run mount."""
    containers = spec.get("containers", [])
    if len(containers) != 1:
        raise RuntimeError("Database binding requires the reviewed single application container")
    entries = containers[0].get("env", [])
    values = {row.get("name"): row for row in entries}
    if len(values) != len(entries):
        raise RuntimeError("Ambiguous Cloud Run environment configuration")
    def literal(key):
        row = values.get(key, {})
        if row.get("valueSource"):
            raise RuntimeError("DB routing/name is opaque; identity cannot be verified without a separately reviewed read path")
        return row.get("value", "")
    connection = target["summary"]["connection_name"]
    if (literal("INSTANCE_UNIX_SOCKET") != "/cloudsql/" + connection
            or literal("DB_NAME") != target["summary"]["database"] or literal("DATABASE_URL")):
        raise RuntimeError("Cloud Run database configuration does not match the Cloud SQL backup/inspection target")
    volumes = {row.get("name"): row for row in spec.get("volumes", [])}
    mounts = [row for row in containers[0].get("volumeMounts", []) if row.get("mountPath") == "/cloudsql"]
    if (len(mounts) != 1 or volumes.get(mounts[0].get("name"), {}).get("cloudSqlInstance", {}).get("instances") != [connection]):
        raise RuntimeError("Cloud Run's database socket is not bound to the verified Cloud SQL instance")


def request_timeout(spec):
    value = spec.get("timeout", "")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,9})?s", value):
        raise RuntimeError("Actual Cloud Run request timeout is missing or invalid")
    seconds = Decimal(value[:-1])
    if not 0 < seconds <= 3600:
        raise RuntimeError("Actual Cloud Run request timeout is outside the supported range")
    return int(seconds.to_integral_value(rounding=ROUND_CEILING))


class DatabaseInspector:
    def __init__(self, expected_database, *, environment=None, runner=None):
        self.expected_database = expected_database
        self.environment = os.environ if environment is None else environment
        self.runner = subprocess.run if runner is None else runner

    def read(self, target):
        env = self.environment
        # Never silently retarget a development connection or accept an opaque
        # service file, proxy, socket, DSN, multi-host list or arbitrary port.
        try:
            host = str(ipaddress.ip_address(env.get("PGHOST", "")))
        except ValueError:
            raise RuntimeError("Existing direct PostgreSQL host identity is unavailable; proxy/socket connections are not verified") from None
        if (host not in target["addresses"] or env.get("PGHOSTADDR", host) != host
                or env.get("PGPORT", "5432") != "5432" or env.get("PGSERVICE")
                or env.get("PGDATABASE") != self.expected_database
                or target["summary"]["database"] != self.expected_database or not env.get("PGUSER")):
            raise RuntimeError("PostgreSQL connection does not match the Cloud SQL target; no connection was attempted")
        # Reuse credentials only. Do not inherit routing/options that can defeat
        # the binding. GSS is disabled so the certificate-verified TLS path wins.
        child = {key: env[key] for key in ("PATH", "HOME", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGSSLCERT", "PGSSLKEY", "PGSSLCRL", "PGSSLCRLDIR") if key in env}
        child.update(PGHOST=host, PGHOSTADDR=host, PGPORT="5432", PGDATABASE=self.expected_database,
                     PGSSLMODE="verify-ca", PGGSSENCMODE="disable", PGCONNECT_TIMEOUT="5",
                     PGOPTIONS="-c default_transaction_read_only=on", PGAPPNAME="integrated-readonly-inspection")
        sql = Path(__file__).with_name("database-inspection.sql").read_text()
        try:
            with tempfile.TemporaryDirectory(prefix="reviewed-cloudsql-ca-") as directory:
                ca = Path(directory) / "server-ca.pem"
                ca.write_text(target["certificate"]); ca.chmod(0o600)
                child["PGSSLROOTCERT"] = str(ca)
                result = self.runner(["psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1", "-c", sql],
                                     env=child, capture_output=True, text=True, timeout=10)
            if result.returncode:
                raise ValueError()
            rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            if len(rows) != 1 or rows[0].pop("database") != self.expected_database or rows[0].pop("tls") is not True:
                raise ValueError()
            observation = rows[0]
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            raise RuntimeError("Verified read-only database inspection failed; connection/query details suppressed") from None
        if (observation.get("stats_visible") is not True or observation.get("track_activities") is not True
                or observation.get("unknown_client_sessions") != 0):
            raise RuntimeError("Complete activity visibility is not verified; zero visible transactions is not quiescence")
        for key in ("active_other_transactions", "prepared_transactions"):
            if type(observation.get(key)) is not int or observation[key] < 0:
                raise RuntimeError("Database activity evidence is incomplete")
        observation["target_sha256"] = fingerprint(target["summary"])
        return observation


def verified_context(cloud, raw, database, baseline_revision=None):
    target = database_target(cloud.instance(), cloud.project, cloud.sql_instance, database.expected_database)
    assert_run_database(raw.get("template", {}), target)
    rows = [row for row in raw.get("trafficStatuses", []) if row.get("percent")]
    if len(rows) != 1 or rows[0].get("percent") != 100 or not rows[0].get("revision"):
        raise RuntimeError("Actual serving revision is not unambiguous")
    serving_name = rows[0]["revision"].rsplit("/", 1)[-1]
    serving = cloud.revision(serving_name)
    assert_run_database(serving, target)
    baseline = serving if not baseline_revision or baseline_revision == serving_name else cloud.revision(baseline_revision)
    assert_run_database(baseline, target)
    timeouts = {"template": request_timeout(raw["template"]), "serving": request_timeout(serving), "baseline": request_timeout(baseline)}
    return {"target": target["summary"], "database": database.read(target), "timeouts": timeouts,
            "serving_image": serving["containers"][0]["image"]}
