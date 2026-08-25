const moment = require('moment-timezone')

const db = require('../db/uploads')
const segmentService = require('./segments')

/**
 * STUCK UPLOAD REAPER
 *
 * WHY THIS EXISTS. An upload sits at status=UPLOADED(10) from the moment the
 * consumer picks it up until ingest writes a terminal status. If the worker
 * stalls or dies mid-flight -- e.g. a durable PUT that blocks ~92s on an
 * overloaded hot tier, then has its retries rejected by the writer's own
 * in-flight PUT bulkhead -- nothing ever moves that row. Observed 2026-08-21:
 * six uploads stranded at status=10, four of them for 23h+, two for 3-4 days.
 * There was no reaper, no alert, and no timeout: the rows simply sat there.
 *
 * ⚠️ THE POPULATION IS NOT HOMOGENEOUS. This is the whole reason the job is
 * shaped the way it is. Probing the six stranded uploads on 2026-08-22 found
 * TWO DISTINCT CLASSES, and a naive "fail everything that is old" reaper would
 * have destroyed real data:
 *
 *   CLASS A -- the ingest actually SUCCEEDED and only the status write was
 *     lost. Core has the source file AND its segments, and the audio is
 *     present on the storage tiers (measured: 6/6 objects present across
 *     hot/nas/b2 with real byte sizes). Failing these would mark good,
 *     playable recordings as failed; deleting their core rows would strand
 *     audio that is on disk right now.
 *     => ACTION: settle the status to INGESTED(20). Never delete.
 *
 *   CLASS B -- the ingest never got far enough to create anything. No source
 *     file, no segments. The upload's SOURCE OBJECT IS STILL IN THE UPLOAD
 *     BUCKET (all six had `source KEPT`), so the work is recoverable.
 *     => ACTION: mark FAILED(30) with a retryable message so the operator (or
 *        the uploader) can redrive. Nothing to delete in core.
 *
 *   CLASS C -- source file exists but its segments are gone from every tier
 *     (the 2026-08-22 audit's `missing_all` class). Core advertises audio that
 *     does not exist, AND the stale sha1 blocks the user from re-uploading.
 *     => ACTION: report only. Rolling this back means deleting core rows and
 *        randomising a checksum, which is exactly the destructive path that
 *        needed operator sign-off on 2026-08-22. This job will NOT do that
 *        unilaterally; it surfaces the count so a human can act.
 *
 * SAFETY POSTURE. Dry-run by default, like upload-source-cleanup. The age
 * threshold is deliberately far above the observed distribution: over the 7
 * days to 2026-08-22, successful ingests settled with p50 6s / p95 63s and a
 * worst case of 1h29m, so a 3h default cannot catch anything still working.
 * Nothing here deletes; the destructive direction always requires a human.
 */

function parseBool (value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function buildConfig (env = process.env) {
  return {
    dryRun: parseBool(env.STUCK_UPLOAD_REAPER_DRY_RUN, true),
    // 3h >> p95 (63s) and >> observed max (1h29m) for a successful ingest.
    ageHours: parseFloat(env.STUCK_UPLOAD_REAPER_AGE_HOURS || '3'),
    batchSize: parseInt(env.STUCK_UPLOAD_REAPER_BATCH_SIZE || '200', 10),
    // Only UPLOADED(10). WAITING(0) is NOT included: it is a normal resting
    // state, not a stall -- 18,105 rows sat at status=0 across a 10-day window
    // on 2026-08-22, all older than 2h, and a sampled probe found their audio
    // present (5/5). Treating status=0 as stuck would have manufactured a
    // ~15k-row false positive.
    //
    // ⚠️ THIS ARRAY IS INDEX-COUPLED (2026-08-24). `stream_uploads_stuck_idx`
    // is partial `WHERE status = 10`, and PG can only use it while the query's
    // status set is provably equivalent to that scalar -- i.e. while this array
    // has EXACTLY ONE element, UPLOADED. Adding a second status silently makes
    // the index unusable and the scan reverts to a Seq Scan on every daily
    // partition (measured: 20 Seq Scans, 13,357 buffers, which is what blew the
    // 5s statement_timeout and failed 2 of 5 runs before the index existed).
    // If you widen this, widen the index predicate to match -- see
    // assertIndexableStatuses() below.
    statuses: [db.status.UPLOADED]
  }
}

/**
 * Warn LOUDLY if the configured statuses can no longer ride
 * `stream_uploads_stuck_idx`.
 *
 * Non-fatal on purpose: a mismatch makes the scan SLOW, not WRONG, and the
 * reaper's job is important enough to run slowly rather than not at all. But it
 * must not be SILENT -- a 200x regression that looks like "random timeouts under
 * load" is exactly the failure this index was added to end, and it took a live
 * incident plus an EXPLAIN to diagnose the first time.
 */
function assertIndexableStatuses (statuses, logger = console) {
  const indexable = statuses.length === 1 && statuses[0] === db.status.UPLOADED
  if (!indexable) {
    logger.warn(
      'Stuck upload reaper: statuses=' + JSON.stringify(statuses) +
      ' no longer matches the partial index stream_uploads_stuck_idx ' +
      '(WHERE status = 10). The scan will fall back to a Seq Scan on every ' +
      'partition and may exceed the statement timeout. Widen the index ' +
      'predicate in migrations/pg/002-ingest-schema-partitioned.sql to match.'
    )
  }
  return indexable
}

/**
 * Classify one stranded upload by what actually exists downstream.
 * Returns 'A' | 'B' | 'C' plus the evidence used, so the caller can log a
 * decision that a human can audit later.
 */
async function classify (upload) {
  const streamId = upload.streamId
  const checksum = upload.checksum

  if (!streamId || !checksum) {
    return { klass: 'B', reason: 'no streamId/checksum on the upload row' }
  }

  // ⚠️ Use the STRICT lookup, not findIngestedDuplicate. The latter returns
  // null on EVERY failure (auth, network, 404 alike) -- correct for its own
  // best-effort use, but unusable here: class B writes a terminal FAILED
  // status, so a transient Core blip must never be able to masquerade as
  // "nothing exists in core". The strict twin throws instead, and we treat a
  // throw as inconclusive and leave the row for the next run.
  let sourceFile
  try {
    sourceFile = await segmentService.findIngestedDuplicateStrict(
      streamId, checksum, upload.timestamp
    )
  } catch (err) {
    return {
      klass: 'SKIP',
      reason: `core lookup inconclusive (${err && err.message}); leaving for next run`
    }
  }

  if (!sourceFile || !sourceFile.id) {
    // Confirmed absent (a real 404 / empty result, not a swallowed error).
    return { klass: 'B', reason: 'no stream_source_file in core (confirmed absent)' }
  }

  return classifyWithSourceFile(sourceFile)
}

function classifyWithSourceFile (sourceFile) {
  const segments = sourceFile.segments || []
  if (!segments.length) {
    return { klass: 'B', reason: 'source file exists but has no segments' }
  }

  // Source file AND segments exist. Whether this is A or C depends on whether
  // the AUDIO is actually there, which this service cannot cheaply determine
  // (it would need a per-tier HEAD via the reader chain). We deliberately do
  // NOT guess: availability!==1 is core's own signal that the audio is gone.
  const anyUnavailable = segments.some(s => s.availability !== undefined && s.availability !== 1)
  if (anyUnavailable) {
    return { klass: 'C', reason: 'segments exist but core marks them unavailable', sourceFile }
  }

  return { klass: 'A', reason: `source file + ${segments.length} segment(s) present`, sourceFile }
}

async function runStuckUploadReaper (env = process.env) {
  const config = buildConfig(env)
  const cutoff = moment.utc().subtract(config.ageHours, 'hours').toDate()
  const counts = { scanned: 0, settled: 0, failed: 0, reported: 0, skipped: 0, error: 0, dryRun: config.dryRun }

  console.info(`Stuck upload reaper: cutoff=${cutoff.toISOString()} dryRun=${config.dryRun} statuses=${config.statuses}`)
  assertIndexableStatuses(config.statuses)

  const candidates = await db.findStuckUploads({
    statuses: config.statuses,
    updatedBefore: cutoff,
    limit: config.batchSize
  })

  console.info(`Stuck upload reaper: ${candidates.length} candidate(s)`)

  for (const upload of candidates) {
    counts.scanned++
    const id = upload.id || upload._id
    let decision
    try {
      decision = await classify(upload)
    } catch (err) {
      counts.error++
      console.error(`Stuck upload reaper: [${id}] classify failed: ${err && err.message}`)
      continue
    }

    const base = `[${id}] ${upload.originalFilename} stream=${upload.streamId} class=${decision.klass} (${decision.reason})`

    try {
      if (decision.klass === 'A') {
        // Ingest succeeded; only the status write was lost.
        counts.settled++
        console.info(`Stuck upload reaper: ${base} -> settle INGESTED${config.dryRun ? ' [DRY RUN]' : ''}`)
        if (!config.dryRun) {
          await db.updateUploadStatus(id, db.status.INGESTED, null)
        }
      } else if (decision.klass === 'B') {
        // Nothing created in core; the source object is normally still in the
        // upload bucket, so this is recoverable by redrive/re-upload.
        counts.failed++
        console.info(`Stuck upload reaper: ${base} -> mark FAILED${config.dryRun ? ' [DRY RUN]' : ''}`)
        if (!config.dryRun) {
          await db.updateUploadStatus(
            id, db.status.FAILED,
            'Ingest did not complete. Please try again.'
          )
        }
      } else if (decision.klass === 'C') {
        // CLASS C: report only. Deleting core rows + clearing a checksum is
        // destructive and needs a human (see the 2026-08-22 disposition).
        counts.reported++
        console.warn(`Stuck upload reaper: ${base} -> REPORT ONLY (needs operator: core advertises audio that is absent)`)
      } else {
        // SKIP: the Core lookup was inconclusive. Deliberately do nothing --
        // the row stays stranded and the next run re-evaluates it. Doing
        // nothing is always safe; guessing is not.
        counts.skipped++
        console.warn(`Stuck upload reaper: ${base} -> SKIP`)
      }
    } catch (err) {
      counts.error++
      console.error(`Stuck upload reaper: ${base} -> action failed: ${err && err.message}`)
    }
  }

  return counts
}

module.exports = { runStuckUploadReaper, buildConfig, classify, assertIndexableStatuses, _internal: { classify, assertIndexableStatuses } }
