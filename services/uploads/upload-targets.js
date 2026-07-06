function parseBool (value) {
  if (value === undefined || value === null || value === '') { return undefined }
  return value === true || value === 'true'
}

function legacyUploadTarget () {
  if (!process.env.UPLOAD_BUCKET) {
    throw new Error('UPLOAD_BUCKET is required')
  }

  return {
    id: process.env.UPLOAD_TARGET_ID || 'legacy-env-upload-bucket',
    version: Number(process.env.UPLOAD_TARGET_VERSION || 1),
    provider: process.env.UPLOAD_PROVIDER || (process.env.UPLOAD_S3_ENDPOINT ? 's3-compatible' : (process.env.PLATFORM || 'amazon')),
    bucket: process.env.UPLOAD_BUCKET,
    endpoint: process.env.UPLOAD_S3_ENDPOINT,
    region: process.env.UPLOAD_S3_REGION_ID,
    forcePathStyle: parseBool(process.env.UPLOAD_S3_FORCE_PATH_STYLE)
  }
}

async function selectUploadTarget (_context = {}) {
  // Phase 1 compatibility shim: all uploads still use the legacy env-backed
  // target. A future implementation should replace this with a Postgres-backed
  // registry lookup, optionally cached/projected in Redis, while preserving the
  // returned target shape.
  return legacyUploadTarget()
}

function sourceForKey (target, key) {
  return {
    targetId: target.id,
    targetVersion: target.version,
    provider: target.provider,
    bucket: target.bucket,
    key,
    endpoint: target.endpoint,
    region: target.region,
    forcePathStyle: target.forcePathStyle
  }
}

function sourceFromUpload (upload, fallbackKey) {
  if (upload && upload.uploadSource && upload.uploadSource.bucket) {
    return {
      targetId: upload.uploadSource.targetId,
      targetVersion: upload.uploadSource.targetVersion,
      provider: upload.uploadSource.provider,
      bucket: upload.uploadSource.bucket,
      key: upload.uploadSource.key || fallbackKey,
      endpoint: upload.uploadSource.endpoint,
      region: upload.uploadSource.region,
      forcePathStyle: upload.uploadSource.forcePathStyle
    }
  }

  return sourceForKey(legacyUploadTarget(), fallbackKey)
}

module.exports = {
  selectUploadTarget,
  sourceForKey,
  sourceFromUpload,
  legacyUploadTarget
}
