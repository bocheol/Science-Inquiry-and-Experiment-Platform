"""Small Cloud Run / Cloud SQL / GCS adapters using an EXISTING gcloud login.

No login, IAM, bucket, secret, database or account creation is implemented.
Read-only is the default. HTTP errors never include response bodies or tokens.
"""
import json
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request


class CloudError(RuntimeError):
    def __init__(self, status=None):
        self.status = status
        super().__init__("Cloud request failed (HTTP " + str(status or "unknown") + "); reconcile before retrying a mutation")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise CloudError("redirect-denied")


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value):
        raise ValueError("Invalid cloud resource identifier")
    return value


class GoogleApi:
    HOSTS = {"run": "run.googleapis.com/v2", "sql": "sqladmin.googleapis.com/sql/v1beta4",
             "storage": "storage.googleapis.com/storage/v1", "upload": "storage.googleapis.com/upload/storage/v1"}

    def __init__(self, *, allow_writes=False, token_provider=None, transport=None):
        self.allow_writes = allow_writes
        self.token_provider = token_provider or self.existing_token
        self.transport = transport or urllib.request.build_opener(NoRedirect()).open

    @staticmethod
    def existing_token():
        executable = shutil.which("gcloud")
        if not executable:
            raise RuntimeError("Existing authenticated gcloud connection is unavailable")
        result = subprocess.run([executable, "auth", "print-access-token", "--quiet"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=False, text=True)
        if result.returncode or not result.stdout.strip():
            raise RuntimeError("Existing gcloud login cannot supply an access token")
        return result.stdout.strip()

    def request(self, method, api, path, body=None, query=None):
        if method != "GET" and not self.allow_writes:
            raise RuntimeError("Read-only client: cloud mutation disabled")
        if api not in self.HOSTS or not path.startswith("/") or ".." in path or "?" in path:
            raise ValueError("Invalid cloud request path")
        url = "https://" + self.HOSTS[api] + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        payload = None if body is None else json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        request = urllib.request.Request(url, data=payload, method=method,
                                         headers={"Authorization": "Bearer " + self.token_provider(), "Content-Type": "application/json"})
        try:
            with self.transport(request, timeout=30) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise CloudError("oversized")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raise CloudError(error.code) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise CloudError() from None


class CloudResources:
    def __init__(self, api, project, region, service, sql_instance):
        self.api = api
        self.project, self.region, self.service, self.sql_instance = map(identifier, (project, region, service, sql_instance))
        self.service_name = f"projects/{self.project}/locations/{self.region}/services/{self.service}"
        self.sql_path = f"/projects/{self.project}/instances/{self.sql_instance}"

    def get_service(self):
        return self.api.request("GET", "run", "/" + self.service_name)

    def revision(self, revision):
        return self.api.request("GET", "run", "/" + self.service_name + "/revisions/" + identifier(revision))

    def patch_service(self, etag, *, traffic, template=None):
        body = {"name": self.service_name, "etag": etag, "traffic": traffic}
        mask = "traffic"
        if template is not None:
            body["template"] = template
            mask = "template,traffic"
        return self.api.request("PATCH", "run", "/" + self.service_name, body,
                                {"updateMask": mask, "allowMissing": "false"})

    def run_operation(self, name):
        prefix = f"projects/{self.project}/locations/{self.region}/operations/"
        if not name.startswith(prefix) or not re.fullmatch(r"[A-Za-z0-9_-]+", name[len(prefix):]):
            raise ValueError("Operation is outside the reviewed service location")
        return self.api.request("GET", "run", "/" + name)

    def sql_operation(self, name):
        return self.api.request("GET", "sql", f"/projects/{self.project}/operations/" + identifier(name))

    def instance(self):
        return self.api.request("GET", "sql", self.sql_path)

    def backups(self):
        return self.api.request("GET", "sql", self.sql_path + "/backupRuns", query={"maxResults": 100}).get("items", [])

    def backup(self, backup_id):
        return self.api.request("GET", "sql", self.sql_path + "/backupRuns/" + identifier(str(backup_id)))

    def create_backup(self, description):
        return self.api.request("POST", "sql", self.sql_path + "/backupRuns", {"description": description})


class GcsStore:
    """Existing private bucket only. Every write uses a generation precondition."""
    def __init__(self, api, bucket):
        self.api, self.bucket = api, identifier(bucket)

    def check_private(self):
        metadata = self.api.request("GET", "storage", "/b/" + self.bucket,
                                    query={"fields": "iamConfiguration,retentionPolicy"})
        policy = metadata.get("iamConfiguration", {})
        if policy.get("publicAccessPrevention") != "enforced" or not policy.get("uniformBucketLevelAccess", {}).get("enabled"):
            raise RuntimeError("Use an existing private lease bucket with enforced public-access prevention and uniform access; do not change permissions automatically")
        if metadata.get("retentionPolicy"):
            raise RuntimeError("Lease bucket retention policy requires operator review")

    def _path(self, key):
        return "/b/" + self.bucket + "/o/" + urllib.parse.quote(key, safe="")

    def read(self, key):
        metadata = self.api.request("GET", "storage", self._path(key), query={"fields": "generation"})
        generation = str(metadata["generation"])
        value = self.api.request("GET", "storage", self._path(key), query={"alt": "media", "ifGenerationMatch": generation})
        return value, generation

    def create_if_absent(self, key, value):
        return self.replace_if_generation(key, value, "0")

    def replace_if_generation(self, key, value, generation):
        result = self.api.request("POST", "upload", "/b/" + self.bucket + "/o", value,
                                  {"uploadType": "media", "name": key, "ifGenerationMatch": str(generation)})
        return str(result["generation"])

    def delete_if_generation(self, key, generation):
        self.api.request("DELETE", "storage", self._path(key), query={"ifGenerationMatch": str(generation)})
