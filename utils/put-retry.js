// Bounded, jittered-exponential retry for ONE specific segment-PUT failure:
// the s3-writer's in-flight PUT bulkhead rejection (503 SlowDown,
// "s3-writer in-flight PUT limit reached; retry").
//
// WHY THIS EXISTS (2026-08-19 production incident): a single browser
// bulk-backfill sustained ~12% TERMINAL upload failures because the task
// pipeline treated the writer's explicit backpressure signal — whose message
// literally says "retry" — as a fatal error: full rollback, status 30
// (FAILED), "Server failed with processing your file. Please try again
// later." None of the 111 failed files were ever re-ingested; bulk users do
// not click per-file Retry. Capacity bumps (replicas 3→4, then KEDA floor
// 4 / cap 6) reduce collision frequency but the cap is finite — any burst
// beyond it converts transient backpressure into permanent user-visible
// failure. The in-task retry fixes the CLASS.
//
// SCOPE CONSTRAINTS (deliberate — read before widening):
//   - Retries ONLY the throttle signal (SlowDown / the writer's message).
//     Every other error propagates untouched on the FIRST attempt, so all
//     existing classification (services/rfcx/segments.js terminal switch,
//     the 2026-06-30 data-loss-adjacent handled-terminal rules, DLQ nack
//     semantics) is byte-identical for non-throttle failures.
//   - When retries exhaust, the LAST throttle error is re-thrown raw. The
//     caller's catch path (rollback + status 30 + nack->DLQ) is unchanged,
//     so an exhausted burst remains operator-redriveable exactly as today.
//   - Re-PUT of the same segment key is safe: keys are minted from Core
//     data BEFORE the upload loop and are stable across attempts (S3 PUT is
//     an idempotent overwrite); a retry never re-mints keys.
//
// BACKOFF SHAPE: the writer holds a PUT slot-acquire window of
// PUT_ACQUIRE_TIMEOUT = 5s before rejecting, so any retry delay must exceed
// ~5s for the next attempt to see a FRESH window rather than re-joining the
// same saturated one (a sub-5s retry is exactly what the aws-sdk's built-in
// fast retries already tried, and lost). Hence the >5s floor. Defaults:
// 5 attempts, base 6s doubling to an 18s cap, ±30% jitter =>
// ~6+12+18+18 = 54s nominal total (range ~38-70s), floor-clamped to 5.5s.
//
// All knobs are env-tunable (read per call, so tests can override):
//   PUT_RETRY_ATTEMPTS (total attempts incl. the first; default 5)
//   PUT_RETRY_BASE_MS  (first retry delay; default 6000)
//   PUT_RETRY_MAX_MS   (delay cap; default 18000)
//   PUT_RETRY_MIN_MS   (floor after jitter; default 5500 — see above)

const JITTER = 0.3

function envInt (name, dflt) {
  const v = parseInt(process.env[name], 10)
  return Number.isFinite(v) && v > 0 ? v : dflt
}

/**
 * True ONLY for the s3-writer PUT bulkhead rejection (or an upstream S3
 * throttle, which carries the same standard SlowDown code and deserves the
 * same treatment). aws-sdk v2 parses the writer's 503 XML into
 * err.code === 'SlowDown' with the message text preserved; the message match
 * is kept as a fallback so a proxy/SDK layer that mangles the code still
 * classifies correctly.
 * @param {Error} err
 */
function isPutLimitError (err) {
  if (!err) { return false }
  if (err.code === 'SlowDown') { return true }
  const message = typeof err.message === 'string' ? err.message : ''
  return /in-flight PUT limit reached/i.test(message)
}

/**
 * Jittered exponential backoff, clamped to [minMs, maxMs].
 * @param {number} attempt 1-based index of the attempt that just FAILED
 * @param {{baseMs:number,maxMs:number,minMs:number}} o
 * @param {() => number} rng 0..1
 */
function backoffDelayMs (attempt, o, rng) {
  const exp = Math.min(o.baseMs * Math.pow(2, attempt - 1), o.maxMs)
  const jittered = exp * (1 + JITTER * (2 * rng() - 1))
  return Math.max(o.minMs, Math.round(Math.min(jittered, o.maxMs * (1 + JITTER))))
}

/**
 * Run `fn`, retrying ONLY on isPutLimitError with bounded jittered
 * exponential backoff. Any other error propagates immediately. On
 * exhaustion the last throttle error is re-thrown raw.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts] total attempts (>=1)
 * @param {number} [opts.baseMs]
 * @param {number} [opts.maxMs]
 * @param {number} [opts.minMs]
 * @param {(info: {attempt:number, delayMs:number, error:Error}) => void} [opts.onRetry]
 *        called BEFORE each backoff sleep
 * @param {(error: Error) => void} [opts.onExhausted] called once, before the final re-throw
 * @param {(ms: number) => Promise<void>} [opts.sleep] injectable for tests
 * @param {() => number} [opts.rng] injectable for tests
 */
async function retryOnPutLimit (fn, opts = {}) {
  const o = {
    attempts: opts.attempts || envInt('PUT_RETRY_ATTEMPTS', 5),
    baseMs: opts.baseMs || envInt('PUT_RETRY_BASE_MS', 6000),
    maxMs: opts.maxMs || envInt('PUT_RETRY_MAX_MS', 18000),
    minMs: opts.minMs || envInt('PUT_RETRY_MIN_MS', 5500)
  }
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const rng = opts.rng || Math.random
  let lastError
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (!isPutLimitError(err)) { throw err }
      lastError = err
      if (attempt === o.attempts) { break }
      const delayMs = backoffDelayMs(attempt, o, rng)
      if (opts.onRetry) { opts.onRetry({ attempt, delayMs, error: err }) }
      await sleep(delayMs)
    }
  }
  if (opts.onExhausted) { opts.onExhausted(lastError) }
  throw lastError
}

module.exports = { isPutLimitError, backoffDelayMs, retryOnPutLimit }
