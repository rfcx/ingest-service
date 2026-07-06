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

## Future Postgres registry

Postgres should be the source of truth. Redis can be a fast projection/cache, not the canonical store.

Suggested initial tables:

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

- Add Postgres tables and seed one target matching current `UPLOAD_BUCKET`.
- Add registry loader behind a feature flag, for example `UPLOAD_TARGET_REGISTRY_MODE=shadow`.
- Shadow mode compares registry-selected target with env target but still returns env target.
- Emit metrics/logs for mismatches and registry/cache failures.

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
