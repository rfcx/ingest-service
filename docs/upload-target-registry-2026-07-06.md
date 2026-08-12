# Upload Target Registry Architecture

Date: 2026-07-06
Status: design + phase-1 compatibility patch

## Goal

Support multiple possible R2/S3-compatible upload buckets without requiring uploader clients or ingest workers to share a single static `UPLOAD_BUCKET` process setting.

The signing endpoint chooses the upload target. The chosen source location is copied onto the Mongo upload document at creation time. Ingest and redrive then read from that recorded source, so a later registry/policy change cannot move an already-created upload.

## Safety principles for live rollout

1. Add capability before changing behavior.
2. Keep the current bucket selected 100% of the time until verification is complete.
3. Keep legacy fallback for existing Mongo upload documents without `uploadSource`.
4. Do not change uploader app contract until server-side stability is proven.
5. Do not repoint `ingest-service-api` away from the public upload endpoint. Device-facing presigned URLs must remain public.
6. Roll out API first, then tasks, because new uploads can persist `uploadSource` before workers depend on it.
7. Treat target choice as immutable per upload.

## Phase 1 implemented shape

### New internal abstraction

`services/uploads/upload-targets.js`

Current implementation is intentionally env-backed:

- `selectUploadTarget(context)` returns the legacy env target.
- `sourceForKey(target, key)` creates persisted source metadata.
- `sourceFromUpload(upload, fallbackKey)` uses `upload.uploadSource` when present, otherwise falls back to the legacy env target.

This is a no-routing-change compatibility shim. It creates the future seam for a Postgres-backed registry.

### Mongo upload document metadata

New additive field on `StreamUpload`:

```js
uploadSource: {
  targetId: String,
  targetVersion: Number,
  provider: String,
  bucket: String,
  key: String,
  endpoint: String,
  region: String,
  forcePathStyle: Boolean
}
```

Existing documents continue to work because ingest falls back to `UPLOAD_BUCKET`/legacy env if `uploadSource` is absent.

### Signed upload URL flow

`POST /uploads` now:

1. Builds validation context as before.
2. Calls `selectUploadTarget(...)`.
3. Creates Mongo upload with `uploadSource` copied onto the document.
4. Calls `storage.getSignedUrl(path, contentType, upload.uploadSource)`.
5. Returns the same `bucket` field, plus additive `uploadTargetId` for observability/debugging.

The uploader app can keep using `uploadId`, `url`, `path`, and `bucket` as before.

### Ingest flow

`ingest()` now loads the upload document before downloading source audio:

1. `db.getUpload(uploadId)`.
2. `sourceFromUpload(upload, fileStoragePath)`.
3. `storage.download(fileStoragePath, localPath, uploadSource)`.

If ingest has to archive an invalid source file, it copies from the recorded source bucket/key instead of blindly using `UPLOAD_BUCKET`.

## Postgres registry

Postgres should be the source of truth. Redis can be a fast projection/cache, not the canonical store.

The initial DDL is checked in at:

- `db/upload-target-registry.sql`

Initial tables:

```sql
create table upload_targets (
  id text primary key,
  version integer not null default 1,
  provider text not null,
  bucket text not null,
  endpoint text,
  region text,
  force_path_style boolean,
  state text not null check (state in ('enabled', 'draining', 'disabled')),
  priority integer not null default 100,
  locale_tags text[] not null default '{}',
  capacity_weight integer not null default 100,
  secret_ref text not null,
  lifecycle_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table upload_target_policy_versions (
  id bigserial primary key,
  active boolean not null default false,
  policy jsonb not null,
  created_at timestamptz not null default now(),
  created_by text
);
```

Notes:

- Store secret references, not raw access keys.
- Include `version` so upload records can identify the target config generation that produced them.
- Keep temporary health/disable state in Redis only if it is derived and safely rebuildable.
- The router should fail closed to the configured default target if the registry/cache is unavailable during early rollout.

## Redis projection

Possible keys:

- `upload-targets:active:v1` compiled active target list.
- `upload-targets:policy:v1` compiled routing policy.
- `upload-target-health:{targetId}` temporary health/circuit-breaker state.

Projection should include an etag/version. API pods can cache in memory briefly and refresh on version changes.

## Runtime modes

`UPLOAD_TARGET_REGISTRY_MODE` controls lookup behavior:

- unset / `env`: current behavior, always use env-backed `UPLOAD_BUCKET` target.
- `shadow`: query Postgres registry and compare it to the env target, but still return the env target. Registry failures log and fall back to env.
- `active`: return the Postgres-selected target. Do not enable until shadow mode has run cleanly with exactly one env-equivalent enabled target.

Postgres connection envs are explicit and optional:

- `UPLOAD_TARGET_REGISTRY_POSTGRES_HOSTNAME` (fallback `POSTGRES_HOSTNAME`)
- `UPLOAD_TARGET_REGISTRY_POSTGRES_PORT` (fallback `POSTGRES_PORT`, default `5432`)
- `UPLOAD_TARGET_REGISTRY_POSTGRES_DB` (fallback `POSTGRES_DB`, default `core`)
- `UPLOAD_TARGET_REGISTRY_POSTGRES_USERNAME` (fallback `POSTGRES_USERNAME`)
- `UPLOAD_TARGET_REGISTRY_POSTGRES_PASSWORD` (fallback `POSTGRES_PASSWORD`)
- `UPLOAD_TARGET_REGISTRY_POSTGRES_SSL_ENABLED` (fallback `POSTGRES_SSL_ENABLED`)

For rfcx-local LAN/admin access, the Patroni service is reachable at `192.168.2.85:15432`, but in-cluster pods should use `postgres.data.svc.cluster.local:5432`.

## Rollout gates

### Gate A, compatibility code only

- Deploy API with env-backed target selector.
- Verify new upload documents include `uploadSource` for the current bucket.
- Verify signed URL response is unchanged except additive `uploadTargetId`.
- No task rollout required yet, because legacy ingest still works with current bucket.

### Gate B, task compatibility

- Deploy tasks with recorded-source read support.
- Verify ingest logs show upload metadata is loaded before storage download.
- Verify legacy uploads without `uploadSource` still ingest.
- Verify new uploads with `uploadSource` ingest.

### Gate C, registry read path

- Apply `db/upload-target-registry.sql` to the selected Postgres database.
- Seed one enabled target matching current `UPLOAD_BUCKET`/`UPLOAD_S3_*` values, with `id='legacy-env-upload-bucket'`, `version=1`, `provider='s3-compatible'`, `bucket='rfcx-ingest-production'`, `region='auto'`, `force_path_style=true`, and a `secret_ref` pointing to the existing Kubernetes secret/env source, not raw credentials.
- Configure registry Postgres connection envs on `ingest-service-api` only.
- Set `UPLOAD_TARGET_REGISTRY_MODE=shadow` on `ingest-service-api`.
- Shadow mode compares registry-selected target with env target but still returns env target.
- Watch logs for `[upload-targets] registry shadow mismatch` or `registry lookup failed`.
- Keep tasks in env mode unless/until they also need registry lookup. Tasks already read immutable `uploadSource` from Mongo.

### Gate D, registry active, single target

- Switch `selectUploadTarget()` to active registry mode, but registry contains only current target.
- Keep fallback to env target on registry errors.
- Verify no behavior change.

### Gate E, controlled multi-target

- Add second target in `disabled` state.
- Switch to `draining`/`enabled` for a small allowlist or project id.
- Verify upload, ingest, cleanup, redrive, and error archive for that allowlisted traffic.
- Only then broaden routing policy.

## Rollback

- API rollback: deploy previous API image. Documents with additive `uploadSource` remain harmless.
- Task rollback: deploy previous task image. Safe only while active uploads are still on the legacy env bucket. Do not route to non-env buckets until task rollback is no longer needed or old workers are drained.
- Registry rollback: set mode back to env/shadow and disable extra targets.

## Cleanup/source deletion

`upload-source-cleanup` is also source-aware in the phase-1 patch:

- Uses `upload.uploadSource.key` when present.
- Uses `upload.uploadSource.bucket` when present.
- Falls back to derived legacy key and `UPLOAD_BUCKET` for older documents.
- Marks `uploadSourceDeletedAt` and `uploadSourceCleanupMessage` with the actual bucket/key deleted.

## Open implementation items

- Add Postgres migration/table ownership in the appropriate RFCx schema repo.
- Add registry DAO and Redis projection.
- Add metrics: selected target id, registry mode, fallback count, target health state, signed URL creation failures by target.
- Audit any external/manual redrive tooling outside this service so it uses `uploadSource` for source bucket/key when present.
- Decide whether `uploadTargetId` should remain in public API response or become debug-only after rollout.

## 2026-07-07 update: policy-backed ENAM default

The registry selector now reads the active row from `upload_target_policy_versions`.
The supported active policy shape is:

```json
{ "mode": "single-target", "targetId": "r2-enam-upload-bucket" }
```

Selection flow in `UPLOAD_TARGET_REGISTRY_MODE=active`:

1. Load enabled targets from `upload_targets`.
2. Load the active policy from `upload_target_policy_versions`.
3. For `single-target`, return the enabled target whose `id` matches `targetId`.
4. If no active policy exists, fall back to the first enabled target by priority.
5. If the policy references a missing/disabled target or unsupported mode, fail the registry lookup and the caller falls back to the legacy env target.

New seed file:

- `db/upload-target-registry-seed-enam-default.sql`

It upserts two enabled R2 targets:

- `r2-enam-upload-bucket`, bucket `rfcx-ingest-enam`, endpoint `https://0692b20bb14f524d1a0cb43754a2f1ad.r2.cloudflarestorage.com`, secret ref `k8s:apps-prod/ingest-upload-target-r2-enam-creds`, priority `10`, locale tags `enam,north-america,americas`.
- `legacy-env-upload-bucket`, bucket `rfcx-ingest-production`, priority `100`, locale tags `legacy,global`.

It then writes the active policy so the `r2-enam-upload-bucket` registry target, whose bucket is `rfcx-ingest-enam`, is the default selected by the database registry. This does **not** require changing `UPLOAD_BUCKET`; the env bucket can remain `rfcx-ingest-production` while testing registry-active behavior.

## 2026-07-07 update: per-target credential resolution

Registry targets may point at buckets that require different S3 credentials than
the legacy `UPLOAD_S3_ACCESS_KEY_ID` / `UPLOAD_S3_SECRET_KEY` pair. The app now
keeps the registry `secret_ref` as non-secret target metadata and resolves actual
credentials only at signing/download time.

Persisted Mongo `uploadSource` includes `secretRef` but never secret values.
Transient sources passed to storage clients may include `accessKeyId` and
`secretAccessKey` after environment resolution.

Resolution order supports:

1. Explicit env refs in registry: `env:ACCESS_ENV_NAME,SECRET_ENV_NAME`.
2. Target/bucket convention env vars, including:
   - `UPLOAD_TARGET_<TARGET_ID>_ACCESS_KEY_ID` / `_SECRET_KEY`
   - `UPLOAD_TARGET_<BUCKET>_ACCESS_KEY_ID` / `_SECRET_KEY`
   - `UPLOAD_TARGET_<SHORT_BUCKET_SUFFIX>_ACCESS_KEY_ID` / `_SECRET_KEY`

For the prepared ENAM target, the intended app env names are:

```text
UPLOAD_TARGET_ENAM_ACCESS_KEY_ID
UPLOAD_TARGET_ENAM_SECRET_KEY
```

These should be sourced from Kubernetes Secret
`apps-prod/ingest-upload-target-r2-enam-creds`. API pods need them for signed
PUT URL creation; task pods need them for source-object downloads during ingest.
