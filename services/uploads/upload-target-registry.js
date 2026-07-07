const { Pool } = require('pg')

let pool

function parseBool (value) {
  if (value === undefined || value === null || value === '') { return undefined }
  return value === true || value === 'true'
}

function sslConfig () {
  const raw = process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_SSL_ENABLED ?? process.env.POSTGRES_SSL_ENABLED
  if (raw === undefined || raw === null || raw === '') { return undefined }
  return parseBool(raw) ? { rejectUnauthorized: false } : false
}

function registryDbConfig () {
  return {
    host: process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_HOSTNAME || process.env.POSTGRES_HOSTNAME,
    port: Number(process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_PORT || process.env.POSTGRES_PORT || 5432),
    database: process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_DB || process.env.POSTGRES_DB || 'core',
    user: process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_USERNAME || process.env.POSTGRES_USERNAME,
    password: process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
    ssl: sslConfig(),
    max: Number(process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_POOL_MAX || 2),
    idleTimeoutMillis: Number(process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.UPLOAD_TARGET_REGISTRY_POSTGRES_CONNECT_TIMEOUT_MS || 2000)
  }
}

function getPool () {
  if (!pool) {
    pool = new Pool(registryDbConfig())
  }
  return pool
}

function rowToTarget (row) {
  if (!row) { return null }
  return {
    id: row.id,
    version: Number(row.version || 1),
    provider: row.provider,
    bucket: row.bucket,
    endpoint: row.endpoint || undefined,
    region: row.region || undefined,
    forcePathStyle: row.force_path_style === null ? undefined : row.force_path_style
  }
}

async function getEnabledUploadTargets () {
  const result = await getPool().query(`
    SELECT id, version, provider, bucket, endpoint, region, force_path_style, priority, capacity_weight
    FROM upload_targets
    WHERE state = 'enabled'
    ORDER BY priority ASC, id ASC
  `)
  return result.rows.map(rowToTarget).filter(Boolean)
}

async function getActivePolicy () {
  const result = await getPool().query(`
    SELECT policy
    FROM upload_target_policy_versions
    WHERE active = true
    ORDER BY id DESC
    LIMIT 1
  `)
  return result.rows[0] ? result.rows[0].policy : null
}

function selectTargetFromPolicy (targets, policy) {
  if (!policy) { return targets[0] }

  const mode = policy.mode || 'single-target'
  if (mode !== 'single-target') {
    throw new Error(`Unsupported upload target policy mode: ${mode}`)
  }

  const targetId = policy.targetId || policy.defaultTargetId
  if (!targetId) {
    throw new Error('Active upload target policy is missing targetId')
  }

  const target = targets.find((candidate) => candidate.id === targetId)
  if (!target) {
    throw new Error(`Active upload target policy references disabled or missing target: ${targetId}`)
  }
  return target
}

async function selectRegistryUploadTarget (_context = {}) {
  const [targets, policy] = await Promise.all([getEnabledUploadTargets(), getActivePolicy()])
  if (targets.length === 0) {
    throw new Error('No enabled upload targets found in registry')
  }
  return selectTargetFromPolicy(targets, policy)
}

async function closeRegistryPool () {
  if (pool) {
    const closing = pool
    pool = undefined
    await closing.end()
  }
}

module.exports = {
  selectRegistryUploadTarget,
  getEnabledUploadTargets,
  getActivePolicy,
  selectTargetFromPolicy,
  closeRegistryPool,
  registryDbConfig,
  rowToTarget
}
