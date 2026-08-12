-- Seed the current rfcx-local R2 upload bucket as the sole enabled target.
-- Requires db/upload-target-registry.sql to have been applied first.
-- This stores only a secret reference, never raw credentials.

INSERT INTO upload_targets (
  id,
  version,
  provider,
  bucket,
  endpoint,
  region,
  force_path_style,
  state,
  priority,
  capacity_weight,
  secret_ref,
  lifecycle_days
) VALUES (
  'legacy-env-upload-bucket',
  1,
  's3-compatible',
  'rfcx-ingest-production',
  'https://d9f6a131cbef20f6f073d4c1d7a99703.r2.cloudflarestorage.com',
  'auto',
  true,
  'enabled',
  100,
  100,
  'k8s:apps-prod/ingest-service-api-prod-env+ingest-service-api-local-creds:UPLOAD_S3_ACCESS_KEY_ID,UPLOAD_S3_SECRET_KEY',
  1
)
ON CONFLICT (id) DO UPDATE SET
  version = EXCLUDED.version,
  provider = EXCLUDED.provider,
  bucket = EXCLUDED.bucket,
  endpoint = EXCLUDED.endpoint,
  region = EXCLUDED.region,
  force_path_style = EXCLUDED.force_path_style,
  state = EXCLUDED.state,
  priority = EXCLUDED.priority,
  capacity_weight = EXCLUDED.capacity_weight,
  secret_ref = EXCLUDED.secret_ref,
  lifecycle_days = EXCLUDED.lifecycle_days,
  updated_at = now();

INSERT INTO upload_target_policy_versions (active, policy, created_by)
VALUES (
  true,
  '{"mode":"single-target","targetId":"legacy-env-upload-bucket"}'::jsonb,
  'ingest-service/db/upload-target-registry-seed-current-r2.sql'
)
ON CONFLICT (active) WHERE active DO UPDATE SET
  policy = EXCLUDED.policy,
  created_by = EXCLUDED.created_by,
  created_at = now();
