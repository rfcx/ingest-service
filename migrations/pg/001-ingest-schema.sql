-- ---------------------------------------------------------------------------
-- ingest-service: PostgreSQL upload store (mongo2pg S1)
--
-- Replaces the MongoDB `rfcx.streamuploads` collection. Applied behind the
-- UPLOADS_DB=pg flag; while UPLOADS_DB is unset (default 'mongo') nothing in
-- this schema is read or written.
--
-- Shape notes (each one is verified against the LIVE collection, not inferred
-- from the mongoose schema — see rfcx-local runbooks
-- `mongo2pg-S1-design-verification-2026-08-11.md` and
-- `mongo2pg-S1-iterative-rereview-2026-08-11.md`):
--
--  * `id` is char(24): the app generates a 24-hex ObjectId string, exactly as
--    mongoose did. It is NEVER a UUID — the S3/R2 object key is
--    `<streamId>/<id>.<ext>`, so changing the id shape would change where
--    audio is stored and break every already-signed URL.
--  * `sample_rate` / `target_bitrate` are nullable and unused by any live row
--    (0 of 191,542 populated) but ARE live in code (`.opus` filename
--    derivation), so they are kept rather than dropped.
--  * `lane_tier` deliberately has NO CHECK constraint. Validation is app-side
--    (whitelist in the seam); a CHECK here would reject a future lane tier and
--    turn a config change into a failed INSERT.
--  * `ingestion_result` is NOT NULL DEFAULT '{"segments":[]}' — the field is
--    present on 100% of live documents including WAITING ones, so a NULL here
--    would be a shape the app has never seen.
--  * There is deliberately NO DeploymentInfo table: dead code, dropped.
--  * No foreign keys to core-api tables — the coupling is by-value across
--    service boundaries, exactly as it was with Mongo.
--
-- Retention: Mongo expired documents via a 14d TTL index on createdAt. PG has
-- no TTL, so retention becomes an explicit CronJob (S2) deleting by
-- created_at. It MUST stay suspended until after the S3 cutover verification —
-- freshly backfilled rows older than 14d are instantly retention-eligible.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE SCHEMA IF NOT EXISTS ingest;

CREATE TABLE IF NOT EXISTS ingest.stream_uploads (
  id                            char(24)    PRIMARY KEY,        -- app-generated ObjectId hex; NEVER a UUID (S3-key compat)
  stream_id                     text        NOT NULL,
  user_id                       text,
  project_id                    text,
  status                        smallint    NOT NULL DEFAULT 0, -- 0 WAITING/10 UPLOADED/20 INGESTED/30 FAILED/31 DUPLICATE/32 CHECKSUM
  lane_tier                     text        NOT NULL DEFAULT 'standard', -- express|priority|standard; validated app-side (no CHECK: see header)
  "timestamp"                   timestamptz,                    -- recording start (client-supplied)
  duration                      double precision,
  original_filename             text,
  failure_message               text,
  sample_rate                   integer,
  target_bitrate                integer,
  checksum                      text,
  upload_source                 jsonb,                          -- {targetId,targetVersion,provider,bucket,key,endpoint,region,forcePathStyle,secretRef}
  upload_source_deleted_at      timestamptz,
  upload_source_cleanup_message text,
  multipart                     jsonb,                          -- {uploadId,partSizeBytes,partCount,completedAt,abortedAt}; NULL for single-PUT
  ingestion_result              jsonb       NOT NULL DEFAULT '{"segments":[]}'::jsonb,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- status gauges (uploads_failed / uploads_duplicated) + general triage
CREATE INDEX IF NOT EXISTS stream_uploads_status_idx
  ON ingest.stream_uploads (status);

-- retention sweep (S2 CronJob deletes by created_at)
CREATE INDEX IF NOT EXISTS stream_uploads_created_at_idx
  ON ingest.stream_uploads (created_at);

-- quota SUM: only WAITING/UPLOADED rows per project are scanned
CREATE INDEX IF NOT EXISTS stream_uploads_pending_project_idx
  ON ingest.stream_uploads (project_id) WHERE status IN (0, 10);

-- upload-source cleanup candidate scan
CREATE INDEX IF NOT EXISTS stream_uploads_cleanup_idx
  ON ingest.stream_uploads (updated_at)
  WHERE upload_source_deleted_at IS NULL;

-- healthcheck singleton (replaces the Mongo getOrCreateHealthCheck upsert).
-- The API readinessProbe hits /health-check, which IS this query — so this
-- table is on the liveness path, not just diagnostics.
CREATE TABLE IF NOT EXISTS ingest.health_check (
  event      text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
