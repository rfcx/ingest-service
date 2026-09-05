// ---------------------------------------------------------------------------
// PostgreSQL implementation of the upload store (mongo2pg S1).
//
// This is a DROP-IN twin of `services/db/mongo.js`: same exported function
// names, same arguments, same resolved shapes, same error messages. It is
// selected at require time by `services/db/uploads.js` when UPLOADS_DB=pg.
// While UPLOADS_DB is unset (the default) nothing here executes in production.
//
// Contract rules that are load-bearing (do not "simplify" these):
//
//  * The row mapper sets BOTH `id` and `_id`. Callers use both spellings —
//    e.g. `routes/uploads.js` builds a fallback S3 key from `upload._id`, and
//    `upload-source-cleanup.js` logs it. Dropping `_id` silently produces the
//    key "streamId/undefined.flac".
//  * `getUpload` resolves to `null` for a well-formed id that matches no row
//    (mongoose `findById` behaviour — callers such as
//    `assertUploadStatusAccess` test for falsy), but THROWS EmptyResultError
//    for a malformed id (mongoose threw CastError, which mongo.js converted).
//    Both branches are relied upon.
//  * Ids are 24-hex ObjectId strings generated app-side, never UUIDs: the S3
//    object key is derived from the id.
//  * Timestamps are written explicitly by the app, mirroring mongoose.
//
// Deliberately NOT ported: getDeploymentInfo / saveDeploymentInfo /
// updateDeploymentInfo. The DeploymentInfo collection is dead code (no live
// caller, census-confirmed) and is dropped rather than migrated.
// ---------------------------------------------------------------------------

const { Pool } = require('pg')
// bson-objectid, NOT the `bson` package: `bson` is only present transitively
// via mongoose, and S4 deletes mongoose. A direct dependency keeps id
// generation working after the Mongo driver is removed.
const ObjectId = require('bson-objectid')
const { EmptyResultError } = require('@rfcx/http-utils')
const moment = require('moment-timezone')
const uploadTargets = require('../uploads/upload-targets')

const status = { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30, DUPLICATE: 31, CHECKSUM: 32 }
const statusNumbers = Object.values(status)

const LANE_TIERS = ['express', 'priority', 'standard']
const DEFAULT_LANE_TIER = 'standard'
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i

let pool

function parseBool (value) {
  if (value === undefined || value === null || value === '') { return undefined }
  return value === true || value === 'true'
}

function sslConfig () {
  const raw = process.env.UPLOADS_POSTGRES_SSL_ENABLED ?? process.env.POSTGRES_SSL_ENABLED
  if (raw === undefined || raw === null || raw === '') { return undefined }
  return parseBool(raw) ? { rejectUnauthorized: false } : false
}

function uploadsDbConfig () {
  return {
    host: process.env.UPLOADS_POSTGRES_HOSTNAME || process.env.POSTGRES_HOSTNAME,
    port: Number(process.env.UPLOADS_POSTGRES_PORT || process.env.POSTGRES_PORT || 5432),
    database: process.env.UPLOADS_POSTGRES_DB || process.env.POSTGRES_DB || 'core',
    user: process.env.UPLOADS_POSTGRES_USERNAME || process.env.POSTGRES_USERNAME,
    password: process.env.UPLOADS_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
    ssl: sslConfig(),
    max: Number(process.env.UPLOADS_POSTGRES_POOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.UPLOADS_POSTGRES_IDLE_TIMEOUT_MS || 30000),
    // Fail fast, deliberately: the API readinessProbe (failureThreshold 1)
    // calls /health-check, which is a query on this pool. A long connect
    // timeout would turn a brief DB blip into a rolling readiness failure
    // across every API replica before the probe could report anything useful.
    connectionTimeoutMillis: Number(process.env.UPLOADS_POSTGRES_CONNECT_TIMEOUT_MS || 2000),
    statement_timeout: Number(process.env.UPLOADS_POSTGRES_STATEMENT_TIMEOUT_MS || 5000),
    options: `-c search_path=${process.env.UPLOADS_POSTGRES_SCHEMA || 'ingest'}`
  }
}

function getPool () {
  if (!pool) {
    pool = new Pool(uploadsDbConfig())
    // A pool-level 'error' listener is required: without one, an error on an
    // IDLE client is an unhandled 'error' event and takes down the process.
    pool.on('error', (err) => {
      console.error('[uploads-pg] idle client error', err && err.message)
    })
  }
  return pool
}

function query (text, params) {
  return getPool().query(text, params)
}

const COLUMNS = `
  id, stream_id, user_id, project_id, status, lane_tier, "timestamp", duration,
  original_filename, failure_message, sample_rate, target_bitrate, checksum,
  upload_source, upload_source_deleted_at, upload_source_cleanup_message,
  multipart, ingestion_result, created_at, updated_at`

/**
 * Map a stream_uploads row to the object shape callers expect from mongoose.
 * Returns camelCase, and sets BOTH `id` and `_id` (see header).
 */
function rowToUpload (row) {
  if (!row) { return null }
  // char(24) is fixed-width; trim defensively so a comparison or an
  // interpolated S3 key can never carry padding.
  const id = typeof row.id === 'string' ? row.id.trim() : row.id
  const upload = {
    id,
    _id: id,
    streamId: row.stream_id,
    userId: row.user_id ?? undefined,
    projectId: row.project_id ?? undefined,
    status: row.status === null || row.status === undefined ? undefined : Number(row.status),
    laneTier: row.lane_tier ?? undefined,
    timestamp: row.timestamp ?? undefined,
    duration: row.duration === null || row.duration === undefined ? undefined : Number(row.duration),
    originalFilename: row.original_filename ?? undefined,
    failureMessage: row.failure_message ?? undefined,
    sampleRate: row.sample_rate === null || row.sample_rate === undefined ? undefined : Number(row.sample_rate),
    targetBitrate: row.target_bitrate === null || row.target_bitrate === undefined ? undefined : Number(row.target_bitrate),
    checksum: row.checksum ?? undefined,
    uploadSource: row.upload_source ?? undefined,
    uploadSourceDeletedAt: row.upload_source_deleted_at ?? undefined,
    uploadSourceCleanupMessage: row.upload_source_cleanup_message ?? undefined,
    multipart: row.multipart ?? undefined,
    ingestionResult: row.ingestion_result ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined
  }
  return upload
}

function normaliseLaneTier (laneTier) {
  const candidate = `${laneTier ?? ''}`.toLowerCase()
  return LANE_TIERS.includes(candidate) ? candidate : DEFAULT_LANE_TIER
}

function generateId () {
  return (new ObjectId()).toHexString()
}

function generateUpload (opts) {
  const { streamId, userId, timestamp, originalFilename, fileExtension, sampleRate, targetBitrate, checksum, projectId, duration, uploadTarget, laneTier } = opts

  const id = generateId()
  const path = `${streamId}/${id}.${fileExtension}`
  const uploadSource = uploadTarget ? uploadTargets.sourceForKey(uploadTarget, path) : undefined

  // ingestion_result is intentionally omitted from the column list so the
  // NOT NULL DEFAULT '{"segments":[]}' applies (live docs always carry it).
  return query(`
    INSERT INTO ingest.stream_uploads
      (id, stream_id, user_id, project_id, status, lane_tier, "timestamp", duration,
       original_filename, sample_rate, target_bitrate, checksum, upload_source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING ${COLUMNS}`,
  [
    id,
    streamId,
    userId ?? null,
    projectId ?? null,
    status.WAITING,
    normaliseLaneTier(laneTier),
    timestamp ?? null,
    duration ?? null,
    originalFilename ?? null,
    sampleRate ?? null,
    targetBitrate ?? null,
    checksum ?? null,
    uploadSource === undefined ? null : JSON.stringify(uploadSource)
  ])
    .then((result) => {
      const data = rowToUpload(result.rows[0])
      if (data && data._id) {
        return {
          id,
          path,
          uploadSource: data.uploadSource,
          signingSource: uploadTarget ? uploadTargets.sourceForSigning(uploadTarget, path) : undefined
        }
      } else {
        throw Error('Can not create upload.')
      }
    })
}

function getPendingProjectDuration (projectId) {
  if (!projectId) { return Promise.resolve(0) }

  return query(`
    SELECT COALESCE(SUM(duration), 0) AS total_duration
    FROM ingest.stream_uploads
    WHERE project_id = $1 AND status IN ($2, $3) AND duration > 0`,
  [projectId, status.WAITING, status.UPLOADED])
    .then(result => Number(result.rows[0]?.total_duration ?? 0))
}

/**
 * Resolve an upload by id.
 *  - malformed id  -> rejects EmptyResultError (mongoose threw CastError)
 *  - valid, absent -> resolves null (mongoose findById)
 */
function getUpload (id) {
  const key = `${id ?? ''}`.trim()
  if (!OBJECT_ID_RE.test(key)) {
    return Promise.reject(new EmptyResultError('Upload with given id not found.'))
  }
  return query(`SELECT ${COLUMNS} FROM ingest.stream_uploads WHERE id = $1`, [key])
    .then(result => rowToUpload(result.rows[0]))
}

function setUploadMultipart (uploadId, multipart) {
  return query(`
    UPDATE ingest.stream_uploads
    SET multipart = $2::jsonb, updated_at = $3
    WHERE id = $1`,
  [`${uploadId}`.trim(), JSON.stringify(multipart ?? null), new Date()])
}

/**
 * Merge a single key into the multipart jsonb, mirroring mongoose's
 * `$set: { 'multipart.completedAt': ... }` (which creates the subdocument if
 * absent). COALESCE keeps that behaviour when multipart is NULL.
 */
function setMultipartField (uploadId, field) {
  return query(`
    UPDATE ingest.stream_uploads
    SET multipart = jsonb_set(COALESCE(multipart, '{}'::jsonb), $2, to_jsonb($3::timestamptz), true),
        updated_at = $4
    WHERE id = $1`,
  [`${uploadId}`.trim(), `{${field}}`, new Date(), new Date()])
}

function setUploadMultipartCompleted (uploadId) {
  return setMultipartField(uploadId, 'completedAt')
}

function setUploadMultipartAborted (uploadId) {
  return setMultipartField(uploadId, 'abortedAt')
}

/**
 * Flip an upload's status.
 *
 * Semantics preserved from the Mongo implementation:
 *  - synchronous throw on an unknown status number (NOT a rejected promise)
 *  - rejects Error('Upload does not exist') when no row matches
 *  - failureMessage is cleared when transitioning to UPLOADED/INGESTED with a
 *    null message, and otherwise only overwritten when one is supplied
 *  - ingestionResult is only overwritten when provided
 *
 * Knowing upgrade over Mongo: this is a single guarded UPDATE rather than
 * get-then-save, which removes the read-modify-write race between the API and
 * the task consumers.
 *
 * TERMINAL-SUCCESS GUARD (2026-08-24): a row that has reached INGESTED(20) is
 * never moved to a FAILURE status (30/31/32).
 *
 * WHY: the legacy ingest queue has two readers in every tasks pod -- the lane
 * router (channel.consume, push) and the multi-lane consumer's legacy drain
 * (get, poll) -- so the same upload can be ingested twice concurrently. The
 * post-transcode createStreamFileData call correctly arbitrates (one writer
 * wins on the (stream_id, sha1) constraint, the loser gets 400 and rolls back
 * its own segments), but the LOSER WRITES ITS STATUS LAST and so overwrote the
 * winner's INGESTED(20) with 31. Measured 2026-08-18: 423 such rows all-time,
 * 311 (73%) of which HAD in fact ingested -- i.e. the upload record lied about
 * successfully-stored audio, and hid the genuine failures in the same bucket.
 * Record: runbooks/FINDING-ingest-legacy-queue-double-consumption-2026-08-18.md
 * (in the rfcx-local repo).
 *
 * The guard is applied IN SQL, not as a read-then-write, deliberately: a
 * read-modify-write would reintroduce exactly the race it exists to close (the
 * winner can set 20 between a loser's read and its write). The DB arbitrates,
 * the same way it already arbitrates the segment race.
 *
 * Directional, not a lock: 20 -> 20 still succeeds (idempotent re-write, and it
 * is how ingestionResult is refreshed), and every transition INTO 20 is
 * unaffected. Only 20 -> {30,31,32} is refused.
 *
 * A refusal is NOT an error: it returns the current row, so callers (the ingest
 * catch block) proceed exactly as before. It is logged + counted so the
 * duplicate-work rate stays visible -- otherwise this trades a visible lie for
 * an invisible one.
 */
const TERMINAL_SUCCESS = status.INGESTED
const FAILURE_STATUSES = [status.FAILED, status.DUPLICATE, status.CHECKSUM]

/**
 * INGEST CLAIM -- idempotency against DUPLICATE EVENT DELIVERY (2026-08-26).
 *
 * WHY. The upstream path R2 ObjectCreated -> Cloudflare Queue -> r2-ingest-bridge
 * -> rfcx-api webhook -> RabbitMQ is AT-LEAST-ONCE, and in practice it fans out
 * hard: measured 2026-08-26 over a live user burst, 1460 webhook events for 204
 * distinct object keys (mean 7.16, max 42), with 204/204 keys reporting an
 * IDENTICAL byte size on every duplicate -- one physical object, delivered many
 * times. Each delivery is a GENUINE, DISTINCT RabbitMQ message, so neither the
 * single-reader fix (#132) nor any consumer-side dedup can suppress it: 151
 * upload ids were consumed more than once BY THE SAME POD.
 *
 * Without a claim, every duplicate ran the full ingest -- 7.33 R2 downloads,
 * 1.86 transcodes and 1.86 segment-PUT batches PER FILE, of which only 1.00
 * Core create can ever win. ~47% of transcode/S3 work in that burst was thrown
 * away, and the loser then wrote its own status LAST, relabelling a
 * successfully-ingested upload as 31 DUPLICATE (167 of 170 such rows carried a
 * populated ingestion_result.streamSourceFileId -- i.e. proof that THAT ROW had
 * already ingested).
 * Record: runbooks/INCIDENT-2026-08-26-r2-event-fanout-duplicate-ingest.md
 *
 * WHAT THIS DOES. A single atomic UPDATE ... WHERE that both tests and takes the
 * claim, so N concurrent workers racing the same upload produce exactly one
 * winner. It is the DB that arbitrates, never a read-then-write -- a
 * read-modify-write would reintroduce the very race it exists to close.
 *
 * A claim is granted when the row is:
 *   - not already INGESTED(20)            -- terminal success is never redone
 *   - not claimed by a still-live worker  -- i.e. no claim, or an EXPIRED one
 *
 * EXPIRY IS LOAD-BEARING, NOT BOOKKEEPING. A worker that dies mid-ingest must
 * not wedge its upload forever. The claim therefore auto-expires, and the
 * expiry window is deliberately reasoned against the two neighbours that also
 * watch this state:
 *   - observed successful ingests settle at p50 6s / p95 63s, worst 1h29m
 *     (stuck-upload-reaper header, 7 days to 2026-08-22)
 *   - the stuck-upload reaper's own age threshold is 3h
 * The default TTL (30 min) sits ABOVE the observed worst case for normal work
 * but well BELOW the reaper's threshold, so a crashed worker's upload is
 * reclaimable by a later delivery long before the reaper would touch it, and
 * the reaper's "stuck at 10" semantics are unchanged.
 *
 * DELIBERATELY NOT A NEW COLUMN. The claim rides on `ingestion_result` (jsonb,
 * already present, already written by this path) under a reserved `_claim` key,
 * so this needs NO migration on a 300M-row-adjacent live database. buildIngestionResult()
 * overwrites the whole object on success, which naturally clears the claim.
 */
const CLAIM_KEY = '_claim'
const CLAIM_TTL_MS = parseInt(process.env.INGEST_CLAIM_TTL_MS || `${30 * 60 * 1000}`, 10)
const CLAIM_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.INGEST_CLAIM_ENABLED ?? 'on').toLowerCase()
)

// Counters. The claim hides duplicate work, so the RATE of duplicate delivery
// must stay visible -- otherwise this trades a visible waste for an invisible
// one, which is the same mistake the terminal-status guard was careful to avoid.
let claimSkippedTotal = 0
let claimSkippedIngestedTotal = 0
function getClaimSkippedTotal () { return claimSkippedTotal }
function getClaimSkippedIngestedTotal () { return claimSkippedIngestedTotal }

/**
 * Try to claim `uploadId` for ingestion.
 *
 * @returns {Promise<{claimed: boolean, reason: string|null, status: number|null}>}
 *   claimed=true  -> this worker owns the ingest and must proceed
 *   claimed=false -> another delivery already handled/owns it; ACK and return.
 *                    `reason` is 'ingested' (terminal success) or 'in-flight'.
 *
 * NEVER THROWS ON A MISSING ROW being the caller's problem: a genuinely absent
 * upload returns claimed=false/reason='missing' so the caller can fall through
 * to its existing not-found handling rather than crashing a consumer.
 */
function claimUploadForIngest (uploadId, { ttlMs = CLAIM_TTL_MS, workerId = null } = {}) {
  const key = `${uploadId ?? ''}`.trim()
  if (!OBJECT_ID_RE.test(key)) {
    return Promise.reject(new Error('Upload does not exist'))
  }
  if (!CLAIM_ENABLED) {
    return Promise.resolve({ claimed: true, reason: null, status: null })
  }
  const now = moment().tz('UTC').toDate()
  const owner = workerId || `${process.env.HOSTNAME || 'worker'}:${process.pid}`

  // One statement: test-and-set. The WHERE clause is the entire mutual
  // exclusion -- if it matches, this worker won; if it matches nothing, someone
  // else holds the claim or the row is already INGESTED.
  return query(`
    UPDATE ingest.stream_uploads
    SET ingestion_result = COALESCE(ingestion_result, '{}'::jsonb) || jsonb_build_object(
          $2::text, jsonb_build_object('owner', $3::text, 'at', $4::text, 'expiresAt', $5::text))
    WHERE id = $1
      AND status <> $6
      AND (
        ingestion_result -> $2::text IS NULL
        OR (ingestion_result -> $2::text ->> 'expiresAt') IS NULL
        OR (ingestion_result -> $2::text ->> 'expiresAt') < $4::text
      )
    RETURNING id`,
  [
    key,
    CLAIM_KEY,
    owner,
    now.toISOString(),
    new Date(now.getTime() + ttlMs).toISOString(),
    TERMINAL_SUCCESS
  ])
    .then((result) => {
      if (result.rowCount === 1) {
        return { claimed: true, reason: null, status: null }
      }
      // Lost the race (or terminal). Read once, ONLY on this cold path, to
      // report WHY -- conflating "already ingested" with "in flight" would hide
      // exactly the signal that tells us whether the upstream fan-out is fixed.
      return query('SELECT status FROM ingest.stream_uploads WHERE id = $1', [key])
        .then((check) => {
          if (check.rowCount === 0) {
            return { claimed: false, reason: 'missing', status: null }
          }
          const current = Number(check.rows[0].status)
          claimSkippedTotal += 1
          if (current === TERMINAL_SUCCESS) {
            claimSkippedIngestedTotal += 1
            return { claimed: false, reason: 'ingested', status: current }
          }
          return { claimed: false, reason: 'in-flight', status: current }
        })
    })
}

/**
 * Release a claim WITHOUT writing a terminal status.
 *
 * Used when an ingest aborts in a way that should be retryable (transient
 * storage/Core failure re-thrown to the DLQ). Leaving a live claim behind would
 * make a legitimate operator redrive silently no-op until the TTL expired.
 * Success paths do NOT need this: buildIngestionResult() replaces the whole
 * ingestion_result object, which drops the claim with it.
 */
function releaseIngestClaim (uploadId) {
  const key = `${uploadId ?? ''}`.trim()
  if (!OBJECT_ID_RE.test(key) || !CLAIM_ENABLED) {
    return Promise.resolve(false)
  }
  return query(`
    UPDATE ingest.stream_uploads
    SET ingestion_result = ingestion_result - $2::text
    WHERE id = $1 AND ingestion_result ? $2::text
    RETURNING id`, [key, CLAIM_KEY])
    .then((r) => r.rowCount === 1)
    .catch(() => false)
}

function updateUploadStatus (uploadId, statusNumber, failureMessage = null, ingestionResult = null) {
  if (!statusNumbers.includes(statusNumber)) {
    throw new Error('Invalid status')
  }
  const clearFailureMessage = failureMessage == null && [status.UPLOADED, status.INGESTED].includes(statusNumber)
  const key = `${uploadId ?? ''}`.trim()
  if (!OBJECT_ID_RE.test(key)) {
    return Promise.reject(new Error('Upload does not exist'))
  }
  // The terminal-success guard covers 20 -> {30,31,32} (see the block above) and
  // now ALSO 20 -> 10.
  //
  // WHY 20 -> 10 MATTERS (2026-08-26): it is the step that made the 31s
  // possible. A duplicate delivery of an ALREADY-INGESTED upload wrote
  // UPLOADED(10) on arrival, which silently un-did the terminal state; the
  // pre-transcode dedup check then legitimately found the winner's source file
  // and wrote 31 as a legal 10 -> 31 transition, so the existing guard never
  // fired. Measured: 138 upload ids where the SAME POD wrote UPLOADED after it
  // had already written INGESTED.
  //
  // SCOPE IS DELIBERATE -- this refuses only 20 -> 10, never 10 -> anything:
  //   - the stuck-upload reaper's contract ("10 means in flight") is untouched;
  //     it reads rows AT 10, and this cannot create or clear that state.
  //   - a genuine redrive of a FAILED(30) upload still moves 30 -> 10 freely.
  // Only a row that has already SUCCEEDED refuses to go backwards.
  const guarded = FAILURE_STATUSES.includes(statusNumber) || statusNumber === status.UPLOADED

  return query(`
    UPDATE ingest.stream_uploads
    SET status = $2,
        updated_at = $3,
        failure_message = CASE
          WHEN $4::text IS NOT NULL THEN $4::text
          WHEN $5::boolean THEN NULL
          ELSE failure_message END,
        ingestion_result = CASE
          WHEN $6::jsonb IS NOT NULL THEN $6::jsonb
          ELSE ingestion_result END
    WHERE id = $1
      AND NOT ($7::boolean AND status = $8)
    RETURNING ${COLUMNS}`,
  [
    key,
    statusNumber,
    moment().tz('UTC').toDate(),
    failureMessage == null ? null : `${failureMessage}`,
    clearFailureMessage,
    ingestionResult ? JSON.stringify(ingestionResult) : null,
    guarded,
    TERMINAL_SUCCESS
  ])
    .then((result) => {
      if (result.rowCount === 0) {
        // Zero rows means EITHER the row is missing OR the guard refused the
        // transition. Those must not be conflated: the first is an error, the
        // second is the expected outcome of a duplicate ingest. This extra read
        // runs ONLY on the rare zero-row path, so the hot path stays a single
        // statement.
        if (!guarded) {
          throw new Error('Upload does not exist')
        }
        return query(`SELECT ${COLUMNS} FROM ingest.stream_uploads WHERE id = $1`, [key])
          .then((check) => {
            if (check.rowCount === 0) {
              throw new Error('Upload does not exist')
            }
            const row = rowToUpload(check.rows[0])
            if (row.status === TERMINAL_SUCCESS) {
              console.warn(`[${key}] refusing to overwrite INGESTED(${TERMINAL_SUCCESS}) with ${statusNumber}` +
                (failureMessage ? ` ("${failureMessage}")` : '') +
                ' -- audio already ingested by a concurrent worker')
              countTerminalOverwriteRefused()
              return row
            }
            // Row exists, is not terminal, yet nothing updated. Should be
            // unreachable; surface it rather than silently returning.
            throw new Error('Upload status update matched no row')
          })
      }
      return rowToUpload(result.rows[0])
    })
}

// Count of suppressed terminal overwrites. Exposed for the metrics endpoint so
// the duplicate-ingest rate remains observable after this guard hides its most
// visible symptom -- this is the number that tells us whether the single-reader
// fix (gating the legacy drain) actually worked.
let terminalOverwriteRefusedTotal = 0
function countTerminalOverwriteRefused () { terminalOverwriteRefusedTotal += 1 }
function getTerminalOverwriteRefusedTotal () { return terminalOverwriteRefusedTotal }

function countByStatus (statusNumber) {
  return query('SELECT COUNT(*)::bigint AS count FROM ingest.stream_uploads WHERE status = $1', [statusNumber])
    .then(result => Number(result.rows[0]?.count ?? 0))
}

function getUploadDuplicateCount () {
  return countByStatus(status.DUPLICATE)
}

function getUploadFailedCount () {
  return countByStatus(status.FAILED)
}

// The API readinessProbe calls this every 15 s per replica. It MUST NOT write.
//
// Until 2026-09-05 it was an INSERT ... ON CONFLICT upsert. Under
// synchronous replication every COMMIT waits for the standby's WAL write, so
// the probe inherited the standby's latency: on 2026-09-05, 1,592 of 1,782
// ingest_service statement-timeout cancels on the leader were this probe, and
// on every failover it produced ~250 'cannot execute INSERT in a read-only
// transaction' errors (2026-09-01) while evicting BOTH replicas -- which
// protects nobody, because both share the same backend and there is nowhere
// to shed to. A readiness probe that performs a synchronously-replicated write
// fails whenever ANY standby is slow. Reads do not wait on the standby
// (measured: 8 ms during a 30 s SyncRep stall, same as outside it).
//
// Readiness now means "this replica can reach PG and the ingest schema is
// present". The table is created by the migrations (001/002-ingest-schema.sql)
// but NOT seeded -- the old upsert was what created the row -- so an empty
// table is a healthy fresh environment, not a failure: the SELECT succeeding
// (schema resolves, pool works) is the signal, and a missing table still
// throws. The name is kept because the route, the switch-module parity test
// and the mongo twin all reference it. Record: rfcx-local OPEN-ITEMS §288 +
// runbooks/FINDING-2026-09-03-ingest-api-healthcheck-db-write-coupling.md.
function getOrCreateHealthCheck () {
  return query(`
    SELECT event, updated_at
    FROM ingest.health_check
    WHERE event = 'check'`)
    .then(result => result.rows[0] || { event: 'check', updated_at: null })
}

// ---------------------------------------------------------------------------
// upload-source cleanup seam
//
// These two functions exist in BOTH backends so `upload-source-cleanup.js`
// never touches a driver directly. They authorise deletion of real R2/S3
// objects, so the candidate predicate must stay identical between engines.
// ---------------------------------------------------------------------------

/**
 * @param {{ statuses: number[], cutoff: Date, batchSize: number }} opts
 */
function findCleanupCandidates ({ statuses, cutoff, batchSize }) {
  return query(`
    SELECT ${COLUMNS}
    FROM ingest.stream_uploads
    WHERE status = ANY($1::smallint[])
      AND updated_at <= $2
      AND upload_source_deleted_at IS NULL
      AND stream_id IS NOT NULL
      AND checksum IS NOT NULL
      AND original_filename IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT $3`,
  [statuses, cutoff, batchSize])
    .then(result => result.rows.map(rowToUpload))
}

/**
 * Stranded uploads: rows left at a non-terminal status long after any healthy
 * ingest would have settled.
 *
 * Deliberately NOT reusing findCleanupCandidates: that query filters on
 * `upload_source_deleted_at IS NULL`, which is the right guard for source
 * cleanup but the wrong one here (a stranded upload may or may not have had
 * its source reaped, and we must see it either way).
 *
 * `checksum IS NOT NULL` is required because the reaper classifies by looking
 * the checksum up in Core; a row without one cannot be classified and would
 * otherwise be mis-handled.
 *
 * @param {{ statuses: number[], updatedBefore: Date, limit: number }} opts
 */
function findStuckUploads ({ statuses, updatedBefore, limit }) {
  return query(`
    SELECT ${COLUMNS}
    FROM ingest.stream_uploads
    WHERE status = ANY($1::smallint[])
      AND updated_at <= $2
      AND stream_id IS NOT NULL
      AND checksum IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT $3`,
  [statuses, updatedBefore, limit])
    .then(result => result.rows.map(rowToUpload))
}

/**
 * Idempotent by design: the `upload_source_deleted_at IS NULL` guard mirrors
 * Mongo's `$exists:false` so a concurrent second pass cannot overwrite the
 * original deletion record.
 */
function markUploadSourceDeleted (uploadId, message) {
  return query(`
    UPDATE ingest.stream_uploads
    SET upload_source_deleted_at = $2, upload_source_cleanup_message = $3
    WHERE id = $1 AND upload_source_deleted_at IS NULL`,
  [`${uploadId}`.trim(), new Date(), message])
}

// Test/ops helper: not part of the Mongo twin's surface. Lets a process that
// knows it is finished (the cleanup CronJob, a test teardown) release sockets
// without waiting for idle timeouts.
async function closePool () {
  if (pool) {
    const closing = pool
    pool = undefined
    await closing.end()
  }
}

module.exports = {
  generateUpload,
  getPendingProjectDuration,
  setUploadMultipart,
  setUploadMultipartCompleted,
  setUploadMultipartAborted,
  getUpload,
  getUploadDuplicateCount,
  getUploadFailedCount,
  updateUploadStatus,
  claimUploadForIngest,
  releaseIngestClaim,
  getClaimSkippedTotal,
  getClaimSkippedIngestedTotal,
  getOrCreateHealthCheck,
  findCleanupCandidates,
  findStuckUploads,
  markUploadSourceDeleted,
  getTerminalOverwriteRefusedTotal,
  status,
  // exported for tests / migrations, not used by app code
  _internal: { rowToUpload, normaliseLaneTier, generateId, getPool, closePool }
}
