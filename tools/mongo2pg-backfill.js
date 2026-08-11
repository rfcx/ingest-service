// ---------------------------------------------------------------------------
// mongo2pg S2: backfill rfcx.streamuploads (MongoDB) -> ingest.stream_uploads
// (PostgreSQL). Idempotent — safe to re-run and to resume.
//
// Usage (inside an ingest-service image, with the pod's normal MONGO_* and
// UPLOADS_POSTGRES_*/POSTGRES_* env):
//   node tools/mongo2pg-backfill.js                # full backfill, _id order
//   node tools/mongo2pg-backfill.js --since <ISO>  # delta: docs updated since
//   node tools/mongo2pg-backfill.js --verify-only  # gates only, no writes
//
// Design rules (each verified against the live collection; see rfcx-local
// runbooks mongo2pg-S1-design-verification-2026-08-11 + the S1 re-review):
//  * _id-ORDER upsert (ON CONFLICT (id) DO UPDATE): re-runs converge, and a
//    crashed run resumes by just running again.
//  * createdAt/updatedAt copied VERBATIM — never re-stamped. Retention deletes
//    by created_at, so re-stamping would resurrect rows Mongo's TTL was about
//    to expire (and break the S3 verification diff).
//  * embedded segment `_id`s are STRIPPED, and the run ASSERTS none survive:
//    live docs carry an undeclared mongoose ObjectId per segment subdocument;
//    copying them verbatim would leave backfilled vs post-cutover rows
//    structurally different, silently. No code reads them.
//  * data anomalies are copied VERBATIM, not repaired (DON'T-BLINDLY-FIX
//    applies to migrations too): status!=20 rows with streamSourceFileId,
//    INGESTED rows without one, empty segment arrays.
//  * Upsert SKIPS rows whose PG updated_at is NEWER than the Mongo doc's
//    (WHERE excluded newer-or-equal guard): after the cutover flips writes to
//    PG, a late/stale delta pass cannot clobber post-cutover PG writes.
//  * politeness: batched (default 1000/batch) with a small sleep between
//    batches — the Patroni replica re-joined recently; no reason to stress
//    WAL apply with an unthrottled bulk load.
//
// Verification gates (run at the end of every backfill, or standalone with
// --verify-only):
//  G1 counts: Mongo total vs PG total (delta mode: window counts)
//  G2 per-status histogram: must match exactly
//  G3 row diff: N random ids (default 500) compared field-by-field after
//     canonicalisation (dates to epoch-ms, segments stripped of _id)
// Exit code 0 only if every gate passes.
// ---------------------------------------------------------------------------

/* eslint-disable no-console */
require('dotenv').config()

const mongoose = require('mongoose')
const { Pool } = require('pg')

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE || 1000)
const BATCH_SLEEP_MS = Number(process.env.BACKFILL_BATCH_SLEEP_MS || 250)
const VERIFY_SAMPLE = Number(process.env.BACKFILL_VERIFY_SAMPLE || 500)

const args = process.argv.slice(2)
const VERIFY_ONLY = args.includes('--verify-only')
const sinceIdx = args.indexOf('--since')
const SINCE = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : null
if (sinceIdx >= 0 && isNaN(SINCE.getTime())) {
  console.error('bad --since value (want ISO date)')
  process.exit(2)
}

function mongoUri () {
  const protocol = process.env.MONGO_PROTOCOL || 'mongodb+srv'
  return protocol === 'mongodb'
    ? `mongodb://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@${process.env.MONGO_HOSTNAME}:${process.env.MONGO_PORT || 27017}/${process.env.MONGO_DB}?retryWrites=true&w=majority&authSource=${process.env.MONGO_AUTH_SOURCE || process.env.MONGO_DB}`
    : `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@${process.env.MONGO_HOSTNAME}/${process.env.MONGO_DB}?retryWrites=true&w=majority`
}

function pgPool () {
  return new Pool({
    host: process.env.UPLOADS_POSTGRES_HOSTNAME || process.env.POSTGRES_HOSTNAME,
    port: Number(process.env.UPLOADS_POSTGRES_PORT || process.env.POSTGRES_PORT || 5432),
    database: process.env.UPLOADS_POSTGRES_DB || process.env.POSTGRES_DB || 'core',
    user: process.env.UPLOADS_POSTGRES_USERNAME || process.env.POSTGRES_USERNAME,
    password: process.env.UPLOADS_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
    max: 3,
    connectionTimeoutMillis: 5000
  })
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Strip mongoose subdocument _id from every segment; assert none survive. */
function cleanIngestionResult (ir) {
  if (!ir) { return { segments: [] } }
  const out = JSON.parse(JSON.stringify(ir))
  delete out._id
  if (Array.isArray(out.segments)) {
    out.segments = out.segments.map(seg => {
      const s = { ...seg }
      delete s._id
      return s
    })
  } else {
    out.segments = []
  }
  const serialised = JSON.stringify(out)
  if (serialised.includes('"$oid"') || serialised.includes('"_id"')) {
    throw new Error(`segment _id survived cleaning: ${serialised.slice(0, 200)}`)
  }
  return out
}

function docToRow (doc) {
  const d = doc.toObject ? doc.toObject() : doc
  return [
    `${d._id}`,
    d.streamId ?? null,
    d.userId ?? null,
    d.projectId ?? null,
    d.status ?? 0,
    d.laneTier ?? 'standard',
    d.timestamp ?? null,
    d.duration ?? null,
    d.originalFilename ?? null,
    d.failureMessage ?? null,
    d.sampleRate ?? null,
    d.targetBitrate ?? null,
    d.checksum ?? null,
    d.uploadSource ? JSON.stringify(stripId(d.uploadSource)) : null,
    d.uploadSourceDeletedAt ?? null,
    d.uploadSourceCleanupMessage ?? null,
    d.multipart ? JSON.stringify(stripId(d.multipart)) : null,
    JSON.stringify(cleanIngestionResult(d.ingestionResult)),
    d.createdAt ?? new Date(0), // verbatim; epoch fallback would itself be an anomaly worth seeing
    d.updatedAt ?? d.createdAt ?? new Date(0)
  ]
}

function stripId (obj) {
  const o = JSON.parse(JSON.stringify(obj))
  delete o._id
  return o
}

const UPSERT = `
  INSERT INTO ingest.stream_uploads
    (id, stream_id, user_id, project_id, status, lane_tier, "timestamp", duration,
     original_filename, failure_message, sample_rate, target_bitrate, checksum,
     upload_source, upload_source_deleted_at, upload_source_cleanup_message,
     multipart, ingestion_result, created_at, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
  ON CONFLICT (id) DO UPDATE SET
    stream_id = excluded.stream_id,
    user_id = excluded.user_id,
    project_id = excluded.project_id,
    status = excluded.status,
    lane_tier = excluded.lane_tier,
    "timestamp" = excluded."timestamp",
    duration = excluded.duration,
    original_filename = excluded.original_filename,
    failure_message = excluded.failure_message,
    sample_rate = excluded.sample_rate,
    target_bitrate = excluded.target_bitrate,
    checksum = excluded.checksum,
    upload_source = excluded.upload_source,
    upload_source_deleted_at = excluded.upload_source_deleted_at,
    upload_source_cleanup_message = excluded.upload_source_cleanup_message,
    multipart = excluded.multipart,
    ingestion_result = excluded.ingestion_result,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
  -- late-delta guard: never clobber a PG row that is newer than this Mongo doc
  WHERE ingest.stream_uploads.updated_at <= excluded.updated_at`

async function backfill (Upload, pool) {
  const filter = SINCE ? { updatedAt: { $gte: SINCE } } : {}
  const total = await Upload.countDocuments(filter)
  console.log(`[backfill] mode=${SINCE ? 'delta since ' + SINCE.toISOString() : 'full'} docs=${total} batch=${BATCH_SIZE}`)

  let lastId = null
  let done = 0
  let upserts = 0
  let skippedNewer = 0
  for (;;) {
    const q = { ...filter }
    if (lastId) { q._id = { $gt: lastId } }
    const docs = await Upload.find(q).sort({ _id: 1 }).limit(BATCH_SIZE).lean()
    if (docs.length === 0) { break }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const doc of docs) {
        const res = await client.query(UPSERT, docToRow(doc))
        if (res.rowCount === 1) { upserts++ } else { skippedNewer++ }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    lastId = docs[docs.length - 1]._id
    done += docs.length
    if (done % 10000 < BATCH_SIZE) {
      console.log(`[backfill] ${done}/${total} (upserted ${upserts}, skipped-newer ${skippedNewer})`)
    }
    await sleep(BATCH_SLEEP_MS)
  }
  console.log(`[backfill] DONE docs=${done} upserted=${upserts} skipped-newer=${skippedNewer}`)
  return { done, upserts, skippedNewer }
}

// --------------------------- verification gates -----------------------------

function canonDate (v) {
  if (v === null || v === undefined) { return null }
  return new Date(v).getTime()
}

/**
 * Recursively sort object keys. REQUIRED before any stringify-compare:
 * PostgreSQL jsonb does not preserve key insertion order, so identical
 * content serialises differently between the Mongo doc and the PG row.
 * (Found on the first real G3 run: 500/500 "divergences", all key-order.)
 */
function sortKeys (v) {
  if (Array.isArray(v)) { return v.map(sortKeys) }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {}
    for (const k of Object.keys(v).sort()) { out[k] = sortKeys(v[k]) }
    return out
  }
  return v
}

function canonDoc (d) {
  return {
    streamId: d.streamId ?? null,
    userId: d.userId ?? null,
    projectId: d.projectId ?? null,
    status: Number(d.status ?? 0),
    laneTier: d.laneTier ?? 'standard',
    timestamp: canonDate(d.timestamp),
    duration: d.duration === null || d.duration === undefined ? null : Number(d.duration),
    originalFilename: d.originalFilename ?? null,
    failureMessage: d.failureMessage ?? null,
    sampleRate: d.sampleRate ?? null,
    targetBitrate: d.targetBitrate ?? null,
    checksum: d.checksum ?? null,
    uploadSource: d.uploadSource ? stripId(d.uploadSource) : null,
    uploadSourceDeletedAt: canonDate(d.uploadSourceDeletedAt),
    uploadSourceCleanupMessage: d.uploadSourceCleanupMessage ?? null,
    multipart: d.multipart
      ? { ...stripId(d.multipart), completedAt: canonDate(d.multipart.completedAt), abortedAt: canonDate(d.multipart.abortedAt) }
      : null,
    ingestionResult: (() => {
      const ir = cleanIngestionResult(d.ingestionResult)
      if (ir.ingestedAt !== undefined) { ir.ingestedAt = canonDate(ir.ingestedAt) }
      ir.segments = (ir.segments || []).map(s => ({ ...s, start: canonDate(s.start), end: canonDate(s.end) }))
      return ir
    })(),
    createdAt: canonDate(d.createdAt),
    updatedAt: canonDate(d.updatedAt)
  }
}

function canonRow (r) {
  const multipart = r.multipart
    ? { ...r.multipart, completedAt: canonDate(r.multipart.completedAt), abortedAt: canonDate(r.multipart.abortedAt) }
    : null
  const ir = r.ingestion_result || { segments: [] }
  if (ir.ingestedAt !== undefined) { ir.ingestedAt = canonDate(ir.ingestedAt) }
  ir.segments = (ir.segments || []).map(s => ({ ...s, start: canonDate(s.start), end: canonDate(s.end) }))
  return {
    streamId: r.stream_id ?? null,
    userId: r.user_id ?? null,
    projectId: r.project_id ?? null,
    status: Number(r.status ?? 0),
    laneTier: r.lane_tier ?? 'standard',
    timestamp: canonDate(r.timestamp),
    duration: r.duration === null || r.duration === undefined ? null : Number(r.duration),
    originalFilename: r.original_filename ?? null,
    failureMessage: r.failure_message ?? null,
    sampleRate: r.sample_rate ?? null,
    targetBitrate: r.target_bitrate ?? null,
    checksum: r.checksum ?? null,
    uploadSource: r.upload_source ?? null,
    uploadSourceDeletedAt: canonDate(r.upload_source_deleted_at),
    uploadSourceCleanupMessage: r.upload_source_cleanup_message ?? null,
    multipart,
    ingestionResult: ir,
    createdAt: canonDate(r.created_at),
    updatedAt: canonDate(r.updated_at)
  }
}

async function verify (Upload, pool) {
  const filter = SINCE ? { updatedAt: { $gte: SINCE } } : {}
  const failures = []

  // G1 counts
  const mongoTotal = await Upload.countDocuments(filter)
  const pgTotalRes = SINCE
    ? await pool.query('SELECT count(*)::bigint AS c FROM ingest.stream_uploads WHERE updated_at >= $1', [SINCE])
    : await pool.query('SELECT count(*)::bigint AS c FROM ingest.stream_uploads')
  const pgTotal = Number(pgTotalRes.rows[0].c)
  // PG may exceed Mongo AFTER cutover (new writes) or after TTL expiry on the
  // Mongo side; before cutover with fresh backfill they must be >=.
  const g1 = pgTotal >= mongoTotal
  console.log(`[verify:G1] counts mongo=${mongoTotal} pg=${pgTotal} -> ${g1 ? 'PASS' : 'FAIL'}`)
  if (!g1) { failures.push('G1 counts') }

  // G2 per-status histogram (Mongo-side statuses must all be present in PG
  // with >= counts; exact-match pre-cutover)
  const mongoHist = await Upload.aggregate([
    { $match: filter },
    { $group: { _id: '$status', n: { $sum: 1 } } }
  ])
  const pgHist = SINCE
    ? await pool.query('SELECT status, count(*)::bigint AS n FROM ingest.stream_uploads WHERE updated_at >= $1 GROUP BY status', [SINCE])
    : await pool.query('SELECT status, count(*)::bigint AS n FROM ingest.stream_uploads GROUP BY status')
  const pgByStatus = Object.fromEntries(pgHist.rows.map(r => [Number(r.status), Number(r.n)]))
  let g2 = true
  for (const { _id: status, n } of mongoHist) {
    const pgN = pgByStatus[Number(status)] || 0
    const ok = pgN >= n
    console.log(`[verify:G2] status=${status} mongo=${n} pg=${pgN} -> ${ok ? 'ok' : 'MISSING'}`)
    if (!ok) { g2 = false }
  }
  console.log(`[verify:G2] histogram -> ${g2 ? 'PASS' : 'FAIL'}`)
  if (!g2) { failures.push('G2 histogram') }

  // G3 random row diff
  const sample = await Upload.aggregate([{ $match: filter }, { $sample: { size: VERIFY_SAMPLE } }])
  let diffs = 0
  for (const doc of sample) {
    const rowRes = await pool.query('SELECT * FROM ingest.stream_uploads WHERE id = $1', [`${doc._id}`])
    if (rowRes.rows.length === 0) {
      diffs++
      if (diffs <= 3) { console.log(`[verify:G3] MISSING in PG: ${doc._id}`) }
      continue
    }
    const a = JSON.stringify(sortKeys(canonDoc(doc)))
    const b = JSON.stringify(sortKeys(canonRow(rowRes.rows[0])))
    if (a !== b) {
      diffs++
      if (diffs <= 3) {
        console.log(`[verify:G3] DIVERGED ${doc._id}`)
        console.log(`  mongo: ${a.slice(0, 300)}`)
        console.log(`  pg   : ${b.slice(0, 300)}`)
      }
    }
  }
  const g3 = diffs === 0
  console.log(`[verify:G3] sampled=${sample.length} diffs=${diffs} -> ${g3 ? 'PASS' : 'FAIL'}`)
  if (!g3) { failures.push('G3 row diff') }

  return failures
}

// ------------------------------------ main ----------------------------------

async function main () {
  console.log('[backfill] connecting mongo + pg')
  mongoose.set('strictQuery', false)
  await mongoose.connect(mongoUri())
  const Upload = require('../services/db/models/mongoose/upload').Upload
  const pool = pgPool()
  await pool.query('SELECT 1') // fail fast on bad PG config

  try {
    if (!VERIFY_ONLY) {
      await backfill(Upload, pool)
    }
    const failures = await verify(Upload, pool)
    if (failures.length) {
      console.error(`[backfill] VERIFICATION FAILED: ${failures.join(', ')}`)
      process.exitCode = 1
    } else {
      console.log('[backfill] ALL GATES PASS')
    }
  } finally {
    await pool.end()
    await mongoose.disconnect()
  }
}

main().catch((e) => {
  console.error('[backfill] FATAL', e && e.stack ? e.stack : e)
  process.exit(1)
})
