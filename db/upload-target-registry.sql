-- Upload target registry for ingest-service signed upload URLs.
-- Apply to the RFCx Postgres/Timescale cluster database chosen for operational
-- service config (initially expected: core/public). This is intentionally
-- additive and idempotent.

CREATE TABLE IF NOT EXISTS upload_targets (
  id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  provider text NOT NULL,
  bucket text NOT NULL,
  endpoint text,
  region text,
  force_path_style boolean,
  state text NOT NULL CHECK (state IN ('enabled', 'draining', 'disabled')),
  priority integer NOT NULL DEFAULT 100,
  locale_tags text[] NOT NULL DEFAULT '{}',
  capacity_weight integer NOT NULL DEFAULT 100,
  secret_ref text NOT NULL,
  lifecycle_days integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS upload_targets_state_priority_idx
  ON upload_targets (state, priority, id);

CREATE TABLE IF NOT EXISTS upload_target_policy_versions (
  id bigserial PRIMARY KEY,
  active boolean NOT NULL DEFAULT false,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS upload_target_policy_versions_one_active_idx
  ON upload_target_policy_versions (active)
  WHERE active;

COMMENT ON TABLE upload_targets IS
  'Canonical registry of signed-upload destination buckets for ingest-service. Store secret references only, never raw credentials.';
COMMENT ON COLUMN upload_targets.secret_ref IS
  'Reference to Kubernetes/Vault/ops secret material used by ingest-service; raw access keys do not belong in this table.';
COMMENT ON TABLE upload_target_policy_versions IS
  'Versioned upload target routing policies. Redis may cache/project these rows but Postgres is source of truth.';
