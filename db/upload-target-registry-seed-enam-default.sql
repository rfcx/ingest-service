-- Seed RFCx R2 upload targets and make rfcx-ingest-enam the registry default.
-- Requires db/upload-target-registry.sql to have been applied first.
-- This does not require changing UPLOAD_BUCKET; ingest-service must run with
-- UPLOAD_TARGET_REGISTRY_MODE=active to select the database-backed default.
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
  locale_tags,
  capacity_weight,
  secret_ref,
  lifecycle_days
) VALUES
(
  'r2-enam-upload-bucket',
  1,
  's3-compatible',
  'rfcx-ingest-enam',
  'https://0692b20bb14f524d1a0cb43754a2f1ad.r2.cloudflarestorage.com',
  'auto',
  true,
  'enabled',
  10,
  ARRAY['enam', 'north-america', 'americas'],
  100,
  'k8s:apps-prod/ingest-upload-target-r2-enam-creds:UPLOAD_S3_ACCESS_KEY_ID,UPLOAD_S3_SECRET_KEY',
  7
),
(
  'legacy-env-upload-bucket',
  1,
  's3-compatible',
  'rfcx-ingest-production',
  'https://d9f6a131cbef20f6f073d4c1d7a99703.r2.cloudflarestorage.com',
  'auto',
  true,
  'enabled',
  100,
  ARRAY['legacy', 'global'],
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
  locale_tags = EXCLUDED.locale_tags,
  capacity_weight = EXCLUDED.capacity_weight,
  secret_ref = EXCLUDED.secret_ref,
  lifecycle_days = EXCLUDED.lifecycle_days,
  updated_at = now();

INSERT INTO upload_target_policy_versions (active, policy, created_by)
VALUES (
  true,
  '{"mode":"single-target","targetId":"r2-enam-upload-bucket"}'::jsonb,
  'ingest-service/db/upload-target-registry-seed-enam-default.sql'
)
ON CONFLICT (active) WHERE active DO UPDATE SET
  policy = EXCLUDED.policy,
  created_by = EXCLUDED.created_by,
  created_at = now();
