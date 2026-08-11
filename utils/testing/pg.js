// ---------------------------------------------------------------------------
// PostgreSQL test harness (mongo2pg S1) — twin of utils/testing/db.js.
//
// Runs against a REAL PostgreSQL, not a fake: the port depends on jsonb
// behaviour, partial indexes, char(24) comparison semantics and ON CONFLICT,
// none of which an in-memory stub would reproduce faithfully.
//
// It applies THE SAME `migrations/pg/001-ingest-schema.sql` that S2 applies to
// the cluster, VERBATIM, so the tested schema and the deployed schema cannot
// drift.
//
// PARALLELISM: jest runs suites in parallel workers against one server, so each
// worker gets its OWN DATABASE (`<base>_w<JEST_WORKER_ID>`) containing the real
// `ingest` schema. Schema-level isolation was tried first and does not work
// here: `services/db/uploads-pg.js` schema-qualifies its statements (correctly
// — that makes it immune to a surprising search_path), so a per-worker schema
// would have required de-qualifying production SQL purely to suit the tests.
// Database-level isolation keeps production code untouched and is stronger.
// This is the failure the first CI run exposed while every suite passed locally
// when run one at a time.
//
// Connection comes from UPLOADS_POSTGRES_* / POSTGRES_* (see docker-compose:
// CI starts a `postgres` service). When none is configured the PG suites SKIP,
// so the default-path CI gate (UPLOADS_DB unset) never depends on a database.
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

// 002 (partitioned) superseded 001 before any traffic reached the table.
const MIGRATION_PATH = path.join(__dirname, '..', '..', 'migrations', 'pg', '002-ingest-schema-partitioned.sql')

const WORKER_ID = process.env.JEST_WORKER_ID || `p${process.pid}`

// Captured ONCE at module load. connect() rewrites UPLOADS_POSTGRES_DB so the
// module under test targets this worker's database; without a snapshot, a later
// read of the env var would return the worker name and the maintenance
// connection would try to connect to the database it is trying to drop.
const BASE_DB = process.env.UPLOADS_POSTGRES_DB || process.env.POSTGRES_DB || 'postgres'

function baseDbName () {
  return BASE_DB
}

/** This worker's private database. */
function workerDbName () {
  return `${baseDbName()}_w${WORKER_ID}`
}

function baseConfig () {
  return {
    host: process.env.UPLOADS_POSTGRES_HOSTNAME || process.env.POSTGRES_HOSTNAME || 'localhost',
    port: Number(process.env.UPLOADS_POSTGRES_PORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.UPLOADS_POSTGRES_USERNAME || process.env.POSTGRES_USERNAME || 'postgres',
    password: process.env.UPLOADS_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
    connectionTimeoutMillis: 5000
  }
}

function testDbConfig () {
  return { ...baseConfig(), database: workerDbName(), max: 3 }
}

let pool

function getPool () {
  if (!pool) { pool = new Pool(testDbConfig()) }
  return pool
}

/**
 * Has a PostgreSQL been CONFIGURED for the test run?
 *
 * Synchronous and configuration-based on purpose. The PG suites use this to
 * decide skip-vs-run at collection time, which means:
 *   - no PG configured  -> suites SKIP (the default CI gate, with UPLOADS_DB
 *     unset, must never depend on a database being present)
 *   - PG configured but unreachable/broken -> suites RUN and FAIL loudly
 *
 * An async reachability probe was used here first; it made a broken database
 * indistinguishable from an absent one, which is the failure mode most worth
 * surfacing.
 */
function isConfigured () {
  return Boolean(process.env.UPLOADS_POSTGRES_HOSTNAME || process.env.POSTGRES_HOSTNAME)
}

/** Create (or recreate) this worker's database from the maintenance database. */
async function createWorkerDatabase () {
  const admin = new Pool({ ...baseConfig(), database: baseDbName(), max: 1 })
  try {
    // A previous crashed run may have left it behind.
    await admin.query(`DROP DATABASE IF EXISTS "${workerDbName()}"`)
    await admin.query(`CREATE DATABASE "${workerDbName()}"`)
  } finally {
    await admin.end()
  }
}

async function dropWorkerDatabase () {
  const admin = new Pool({ ...baseConfig(), database: baseDbName(), max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${workerDbName()}"`)
  } catch (e) { /* best effort */ } finally {
    await admin.end()
  }
}

/** Apply the real migration file, unmodified. */
async function migrate () {
  await getPool().query(fs.readFileSync(MIGRATION_PATH, 'utf8'))
}

async function connect () {
  await createWorkerDatabase()
  await migrate()
  // exercise the partition-maintenance path the retention job will use
  await getPool().query('SELECT ingest.ensure_partitions(3)')
  // Point the module under test at this worker's database.
  process.env.UPLOADS_POSTGRES_DB = workerDbName()
}

async function truncate () {
  await getPool().query('TRUNCATE ingest.stream_uploads')
}

async function disconnect () {
  if (pool) {
    await pool.end()
    pool = undefined
  }
  try {
    await require('../../services/db/uploads-pg')._internal.closePool()
  } catch (e) { /* best effort */ }
  await dropWorkerDatabase()
  process.env.UPLOADS_POSTGRES_DB = BASE_DB
}

/** Row count of a table in this worker's database. */
async function countRows (table) {
  const result = await getPool().query(`SELECT COUNT(*)::int AS c FROM ingest.${table}`)
  return result.rows[0].c
}

/** Raw row access, for assertions that must see the stored shape not the mapper's. */
async function rawRow (id) {
  const result = await getPool().query('SELECT * FROM ingest.stream_uploads WHERE id = $1', [id])
  return result.rows[0]
}

/**
 * Insert a row directly.
 *
 * NOTE the `undefined ? default : value` shape rather than `??`: a test must be
 * able to force a column to NULL by passing null explicitly. With `??` an
 * explicit null silently fell back to the default, which made a
 * findCleanupCandidates predicate test pass rows it believed were NULL.
 */
async function insertUpload (fields = {}) {
  const uploadsPg = require('../../services/db/uploads-pg')
  const id = fields.id || uploadsPg._internal.generateId()
  const dflt = (value, fallback) => value === undefined ? fallback : value
  const row = {
    id,
    stream_id: dflt(fields.streamId, 'stream000000001'),
    user_id: dflt(fields.userId, 'user-1'),
    project_id: dflt(fields.projectId, null),
    status: dflt(fields.status, 0),
    lane_tier: dflt(fields.laneTier, 'standard'),
    timestamp: dflt(fields.timestamp, new Date()),
    duration: dflt(fields.duration, null),
    original_filename: dflt(fields.originalFilename, 'file.flac'),
    failure_message: dflt(fields.failureMessage, null),
    sample_rate: dflt(fields.sampleRate, null),
    target_bitrate: dflt(fields.targetBitrate, null),
    checksum: dflt(fields.checksum, 'checksum-1'),
    upload_source: fields.uploadSource === undefined ? null : JSON.stringify(fields.uploadSource),
    upload_source_deleted_at: dflt(fields.uploadSourceDeletedAt, null),
    multipart: fields.multipart === undefined ? null : JSON.stringify(fields.multipart),
    created_at: dflt(fields.createdAt, new Date()),
    updated_at: dflt(fields.updatedAt, new Date())
  }
  await getPool().query(`
    INSERT INTO ingest.stream_uploads
      (id, stream_id, user_id, project_id, status, lane_tier, "timestamp", duration,
       original_filename, failure_message, sample_rate, target_bitrate, checksum,
       upload_source, upload_source_deleted_at, multipart, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [row.id, row.stream_id, row.user_id, row.project_id, row.status, row.lane_tier,
    row.timestamp, row.duration, row.original_filename, row.failure_message,
    row.sample_rate, row.target_bitrate, row.checksum, row.upload_source,
    row.upload_source_deleted_at, row.multipart, row.created_at, row.updated_at])
  return id
}

module.exports = {
  isConfigured,
  connect,
  disconnect,
  truncate,
  migrate,
  getPool,
  countRows,
  rawRow,
  insertUpload,
  testDbConfig,
  workerDbName
}
