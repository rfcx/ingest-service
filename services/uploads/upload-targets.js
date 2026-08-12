const registry = require('./upload-target-registry')

function parseBool (value) {
  if (value === undefined || value === null || value === '') { return undefined }
  return value === true || value === 'true'
}

function registryMode () {
  return (process.env.UPLOAD_TARGET_REGISTRY_MODE || 'env').toLowerCase()
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
    forcePathStyle: parseBool(process.env.UPLOAD_S3_FORCE_PATH_STYLE),
    secretRef: process.env.UPLOAD_TARGET_SECRET_REF
  }
}

function targetsEquivalent (a, b) {
  return a && b &&
    a.id === b.id &&
    Number(a.version || 1) === Number(b.version || 1) &&
    a.provider === b.provider &&
    a.bucket === b.bucket &&
    (a.endpoint || undefined) === (b.endpoint || undefined) &&
    (a.region || undefined) === (b.region || undefined) &&
    a.forcePathStyle === b.forcePathStyle
}

function envKeyPart (value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function credentialEnvPairs (source) {
  const pairs = []
  if (source.secretRef && source.secretRef.startsWith('env:')) {
    const names = source.secretRef.slice(4).split(',').map((name) => name.trim()).filter(Boolean)
    if (names.length >= 2) { pairs.push([names[0], names[1]]) }
  }

  const ids = [source.targetId || source.id, source.bucket]
  for (const id of ids) {
    const key = envKeyPart(id)
    if (!key) { continue }
    pairs.push([`UPLOAD_TARGET_${key}_ACCESS_KEY_ID`, `UPLOAD_TARGET_${key}_SECRET_KEY`])
    pairs.push([`UPLOAD_TARGET_${key}_UPLOAD_S3_ACCESS_KEY_ID`, `UPLOAD_TARGET_${key}_UPLOAD_S3_SECRET_KEY`])
  }

  if (source.secretRef && source.secretRef.startsWith('k8s:')) {
    const secretName = source.secretRef.split(':')[1].split('/').pop()
    const key = envKeyPart(secretName)
    if (key) {
      pairs.push([`${key}_UPLOAD_S3_ACCESS_KEY_ID`, `${key}_UPLOAD_S3_SECRET_KEY`])
      pairs.push([`UPLOAD_TARGET_${key}_ACCESS_KEY_ID`, `UPLOAD_TARGET_${key}_SECRET_KEY`])
    }
  }

  if (source.bucket && source.bucket.startsWith('rfcx-ingest-')) {
    const shortName = envKeyPart(source.bucket.replace('rfcx-ingest-', ''))
    if (shortName) {
      pairs.push([`UPLOAD_TARGET_${shortName}_ACCESS_KEY_ID`, `UPLOAD_TARGET_${shortName}_SECRET_KEY`])
      pairs.push([`UPLOAD_TARGET_${shortName}_UPLOAD_S3_ACCESS_KEY_ID`, `UPLOAD_TARGET_${shortName}_UPLOAD_S3_SECRET_KEY`])
    }
  }

  return pairs
}

function credentialsForSource (source) {
  for (const [accessKeyEnv, secretKeyEnv] of credentialEnvPairs(source)) {
    if (process.env[accessKeyEnv] && process.env[secretKeyEnv]) {
      return {
        accessKeyId: process.env[accessKeyEnv],
        secretAccessKey: process.env[secretKeyEnv]
      }
    }
  }
  return undefined
}

function sourceWithCredentials (source) {
  const credentials = credentialsForSource(source)
  if (!credentials) { return source }
  return { ...source, ...credentials }
}

async function selectUploadTarget (context = {}) {
  const mode = registryMode()
  const legacy = legacyUploadTarget()

  if (mode === 'env' || mode === 'off' || mode === 'disabled') {
    return legacy
  }

  try {
    const selected = await registry.selectRegistryUploadTarget(context)

    if (mode === 'shadow') {
      if (!targetsEquivalent(legacy, selected)) {
        console.warn('[upload-targets] registry shadow mismatch', JSON.stringify({ legacy, selected }))
      }
      return legacy
    }

    if (mode === 'active') {
      return selected
    }

    console.warn(`[upload-targets] unknown UPLOAD_TARGET_REGISTRY_MODE=${mode}; falling back to env target`)
    return legacy
  } catch (err) {
    console.error('[upload-targets] registry lookup failed; falling back to env target', err && err.message)
    return legacy
  }
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
    forcePathStyle: target.forcePathStyle,
    secretRef: target.secretRef
  }
}

function sourceForSigning (target, key) {
  return sourceWithCredentials(sourceForKey(target, key))
}

function sourceFromUpload (upload, fallbackKey) {
  if (upload && upload.uploadSource && upload.uploadSource.bucket) {
    return sourceWithCredentials({
      targetId: upload.uploadSource.targetId,
      targetVersion: upload.uploadSource.targetVersion,
      provider: upload.uploadSource.provider,
      bucket: upload.uploadSource.bucket,
      key: upload.uploadSource.key || fallbackKey,
      endpoint: upload.uploadSource.endpoint,
      region: upload.uploadSource.region,
      forcePathStyle: upload.uploadSource.forcePathStyle,
      secretRef: upload.uploadSource.secretRef
    })
  }

  return sourceForSigning(legacyUploadTarget(), fallbackKey)
}

module.exports = {
  selectUploadTarget,
  sourceForKey,
  sourceForSigning,
  sourceFromUpload,
  legacyUploadTarget,
  registryMode,
  targetsEquivalent,
  credentialsForSource
}
