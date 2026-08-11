-- ---------------------------------------------------------------------------
-- ingest-service: PostgreSQL upload store v2 — PARTITIONED (mongo2pg S2b).
--
-- Supersedes 001-ingest-schema.sql (plain table). Rebuilt before any traffic
-- reached the table, on the operator's scaling premise: bursty ingestion with
-- million-row weeks plausible. The table must be optimized for INSERT and for
-- the service's exact lookups; retention must not be row-by-row DELETE.
--
-- Shape: daily RANGE partitions on created_at.
--  * retention = DROP PARTITION: O(1), no dead tuples, no vacuum churn — the
--    log-style lifecycle, kept inside one store.
--  * insert path touches 3 indexes (PK + 2 partials), each tiny (one day /
--    active-subset); the old full created_at index is REPLACED by partition
--    pruning, and the full status index shrinks to a partial for the gauges.
--  * lookups preserved:
--      - getUpload:            PK (id, created_at) — probes each day's small
--                              index; ~retention-window probes, microseconds.
--      - getPendingProjectDuration: partial (project_id) WHERE status IN (0,10)
--      - findCleanupCandidates:     partial (updated_at) WHERE
--                                   upload_source_deleted_at IS NULL
--      - gauges (failed/duplicate): partial (status) WHERE status IN (30,31)
--
-- PARTITIONED-PK NOTE (the one semantic trade): a partitioned table's PK must
-- include the partition key, so the PK is (id, created_at). Global id
-- uniqueness is not DB-enforced across days — acceptable because ids are
-- app-generated ObjectIds (24-hex, time-prefixed, collision-negligible) and
-- the app always looks up by id alone. The seam's queries use WHERE id = $1
-- unchanged. The backfill upserts ON CONFLICT (id, created_at) — safe because
-- createdAt is copied verbatim and immutable.
--
-- PARTITION MAINTENANCE lives with retention (the same daily CronJob):
--  ensure_partitions(days_ahead) creates upcoming daily partitions;
--  drop_expired_partitions(retention_days) detaches+drops aged ones.
--  A DEFAULT partition catches any row outside known ranges (never lost);
--  drop_expired refuses to touch it.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE SCHEMA IF NOT EXISTS ingest;

CREATE TABLE IF NOT EXISTS ingest.stream_uploads (
  id                            char(24)    NOT NULL,
  stream_id                     text        NOT NULL,
  user_id                       text,
  project_id                    text,
  status                        smallint    NOT NULL DEFAULT 0,
  lane_tier                     text        NOT NULL DEFAULT 'standard',
  "timestamp"                   timestamptz,
  duration                      double precision,
  original_filename             text,
  failure_message               text,
  sample_rate                   integer,
  target_bitrate                integer,
  checksum                      text,
  upload_source                 jsonb,
  upload_source_deleted_at      timestamptz,
  upload_source_cleanup_message text,
  multipart                     jsonb,
  ingestion_result              jsonb       NOT NULL DEFAULT '{"segments":[]}'::jsonb,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- catch-all so no row can ever fail to route; retention never drops this one
CREATE TABLE IF NOT EXISTS ingest.stream_uploads_default
  PARTITION OF ingest.stream_uploads DEFAULT;

-- quota SUM: only WAITING/UPLOADED rows per project
CREATE INDEX IF NOT EXISTS stream_uploads_pending_project_idx
  ON ingest.stream_uploads (project_id) WHERE status IN (0, 10);

-- cleanup candidate scan
CREATE INDEX IF NOT EXISTS stream_uploads_cleanup_idx
  ON ingest.stream_uploads (updated_at)
  WHERE upload_source_deleted_at IS NULL;

-- status gauges (uploads_failed / uploads_duplicated) — partial replaces the
-- old full status index; WAITING/UPLOADED scans ride the pending partial.
CREATE INDEX IF NOT EXISTS stream_uploads_gauge_status_idx
  ON ingest.stream_uploads (status) WHERE status IN (30, 31);

-- healthcheck singleton (not partitioned; one row)
CREATE TABLE IF NOT EXISTS ingest.health_check (
  event      text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- partition maintenance
-- ---------------------------------------------------------------------------

-- Create daily partitions from today-1 through today+days_ahead (idempotent).
CREATE OR REPLACE FUNCTION ingest.ensure_partitions (days_ahead integer DEFAULT 3)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE
  d date;
  created integer := 0;
  part text;
BEGIN
  FOR d IN SELECT generate_series(current_date - 1, current_date + days_ahead, interval '1 day')::date LOOP
    part := 'stream_uploads_p' || to_char(d, 'YYYYMMDD');
    IF NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'ingest' AND c.relname = part) THEN
      EXECUTE format(
        'CREATE TABLE ingest.%I PARTITION OF ingest.stream_uploads FOR VALUES FROM (%L) TO (%L)',
        part, d, d + 1);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$fn$;

-- Drop whole partitions strictly older than the retention window. Never
-- touches the DEFAULT partition. Returns the number of partitions dropped.
CREATE OR REPLACE FUNCTION ingest.drop_expired_partitions (retention_days integer DEFAULT 14)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  cutoff date := current_date - retention_days;
  bound_to date;
  dropped integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE n.nspname = 'ingest'
      AND i.inhparent = 'ingest.stream_uploads'::regclass
      AND c.relname LIKE 'stream\_uploads\_p%'
  LOOP
    -- partition name encodes its day: stream_uploads_pYYYYMMDD covers [d, d+1)
    bound_to := to_date(right(r.relname, 8), 'YYYYMMDD') + 1;
    IF bound_to <= cutoff THEN
      EXECUTE format('ALTER TABLE ingest.stream_uploads DETACH PARTITION ingest.%I', r.relname);
      EXECUTE format('DROP TABLE ingest.%I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$fn$;

COMMIT;