# Integrated deployment preparation

These tools prepare and validate a reviewed release. CI runs only synthetic,
isolated checks. No workflow deploys to Cloud Run or accesses production data.
The journal-only deployment command is not compatible with this release.

## What is built and how it is identified

- `prepare-integrated-deployment.py` exports one immutable candidate commit and
  its preparation, execution, inspection and maintenance code. Every artifact's
  path, mode, size and SHA-256 is inventoried. Execute the copy under the exported
  `tools/` directory; the executor verifies the whole approved inventory first.
- The normal rollback application is a separate previously reviewed commit:
  `86c028cd00efa1e012ef91cbb254796f952209bc`. Both applications must have exactly
  the same migration metadata and checksums through 0015. Its Dockerfile's Node
  references are pinned by the reviewed preparer; the original and derived file
  hashes are recorded. The application source is unchanged.
- The Node digest comes from the successful prior container CI. Both product
  stages and the maintenance image use that digest. The Cloud Build Docker
  builder must also be supplied by a separately reviewed digest; no floating
  builder is accepted. The synthetic builder in `create-ci-package.py` is only
  a fixture and must never be used for a real build.
- Production images must be addressed by registry digest, with the source
  archive, build record and image provenance reviewed and bound into the plan.
  CI's local Docker **image config IDs are not registry manifest digests**.
  An operator-reviewed build declaration is a required input; the executor does
  not independently attest a Cloud Build source upload or cryptographically
  attest an image. Do not mark this input verified without checking that record.

## Read-only inspection first

`integrated_executor.py --command inspect` uses an **existing** gcloud login and
an existing libpq connection (`PG*` variables or service file). Its input needs
the selected project, region, service, SQL instance and database name. The
default command makes GET requests and a `BEGIN READ ONLY` migration query; it
does not acquire a lease. It prints revision/image identifiers and fingerprints,
not environment values or database credentials. Keep its output outside Git.

Do not use the application `/api/health` endpoint for a production read-only
audit: the application `getDb()` can initialize the schema and run migrations.
The separate maintenance image's health handler only reads migration metadata.

Run `google-readonly.mjs` only in the existing server identity and credential
context. It reads teacher destination configuration with direct read-only SQL
and requests restricted Google file/Sheet metadata. It never reads student
records or cell values, uploads files, or changes sharing. `K_SERVICE`, token
availability and file existence alone do not establish usable write access.
The probe reports metadata access and advertised capabilities, not an upload,
quota or real teacher-sharing test.

No tool creates login credentials, IAM policies, secrets, buckets or instances.
Missing access is a blocker, not permission to create or broaden access.

## Reviewable execution sequence

Prepare the exact candidate/rollback commits, fixed builder digest and private
image repository. Keep the production execution plan, backup evidence and state
file **outside** the build package and repository. The final approval binds the
complete execution plan SHA-256, prepared artifact inventory, source commits,
image digests, current service UID/etag/template/access-policy fingerprints,
database migration manifest and explicit maintenance/drain assumptions.

The executor is deliberately one step at a time; `step` requests an operation and
`reconcile` confirms its observed outcome. A requested operation is not success.
Mutating commands require the separately approved exact plan hash and package.

1. Acquire the canonical service lease in an existing private GCS bucket. The
   bucket must already enforce public-access prevention and uniform access.
   Generation preconditions protect every checkpoint and delete. The lease is
   non-expiring: another run cannot steal it after a crash.
2. Stage the maintenance image while preserving explicit traffic to the current
   revision. No revision tags are created. Multi-container services or custom
   entrypoints require a separate compatibility review.
3. Move all traffic to maintenance, confirm that state, and wait at least the
   existing request timeout plus 30 seconds. Confirm that schedulers/background
   writers are quiescent and no other database transactions remain. A traffic
   switch alone is not proof that all writers have stopped.
4. Create and verify a fresh Cloud SQL backup. Before any migration-capable
   revision, require evidence for that exact backup restored to a **different,
   already approved** instance, a completed restore operation, matching migration
   metadata and an operator-reviewed application read check. The SQL operation
   alone does not prove application contents or which backup was restored;
   binding those facts is an explicit operator attestation. CI does not replace
   the production restore check.
5. Stage the normal rollback application first, still with maintenance traffic.
   Its startup probe can apply 0013–0015. Confirm its pinned image, readiness and
   the exact full migration manifest before staging the candidate.
6. Stage the candidate without traffic; confirm it, then explicitly promote it.
   In-flight requests may finish on the prior revision. The two application
   versions are required to support the identical schema.
7. If candidate staging fails with an observed completed operation and the known
   normal revision is ready on the intact 0015 schema, explicitly recover traffic
   to that normal application. Finish releases the lease only after observing a
   ready serving revision and the matching database state.

The 503 maintenance image is **not normal recovery**. Do not return to a 0012-only
application after the database advances. If normal staging/migration fails or
the schema is unknown, retain maintenance and the lease. Database restore is a
separate incident decision with potential loss of writes after the backup; the
executor never restores or downgrades the live database automatically. A normal
rollback also cannot recall student data already sent to an external service.

## Interruption and concurrency limits

The local journal uses exclusive creation, process locking, atomic replacement
and file/directory fsync. Intent is checkpointed remotely **before** a mutation.
The current generation and Cloud Run etag must still match before another write.
After a lost response, inspect the operation and expected immutable revision;
never blindly repeat a patch or backup creation. An unresolved outcome retains
the lease. Divergent local/remote checkpoints require explicit comparison and
preservation; the tool does not overwrite either copy to force a restart.

This coordinates callers using the same canonical lease. It cannot prevent
uncoordinated console changes or a principal deliberately deleting a lease.
Unexpected service changes stop this executor. Cloud-side adapter behavior is
covered by offline tests, not a claim of a completed live Cloud Run rehearsal.

## Automated evidence and remaining operating checks

The workflow includes Python state/executor/preparation checks and restricted
Node maintenance/Google-probe checks. Migration imports run with no inherited
credentials and Linux network-denial rules. Separate real PostgreSQL tests cover
revocation, delayed authentication, slow export with unrelated saves, and bounded
lock/network waits. The container drill uses an internal Docker network, synthetic
accounts, real `pg_dump`/`pg_restore`, and actual application images to check login,
private-record isolation and write/read behavior on upgraded and restored DBs.

Operating revision/traffic, actual backup restorability, teacher account mapping,
server Google identity/sharing, physical shared devices, paid AI quality and a
whole-semester cost hard cap remain separate checks. No task here enforces every
external charge or implements the semester budget cap.

Official API contracts used by the adapters:

- [Cloud Run service patch and etag](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch)
- [Cloud Run reconciliation and traffic state](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services)
- [GCS generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
- [Cloud SQL restore behavior](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/restoring)
