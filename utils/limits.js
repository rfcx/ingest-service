/**
 * Centralised ingestion limits + ffmpeg timeouts.
 *
 * All values are env-overridable so they can be tuned (per environment) without
 * a code change/rebuild. The defaults below are the production rfcx-local
 * defaults.
 *
 * Size caps are enforced per file extension (see routes/uploads.js and the
 * consumer modules). FLAC is allowed to be large because it is already
 * compressed; WAV (uncompressed) and other formats stay tightly bounded so a
 * single file can never blow up the worker's scratch space.
 */

function intFromEnv (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') { return fallback }
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ---- Upload size caps (bytes) ----------------------------------------------
// FLAC may be large (already compressed). Default 1 GiB.
const flacLimitSize = intFromEnv('MAX_FLAC_BYTES', 1_073_741_824)
// WAV stays bounded (uncompressed -> expensive to process). Default 200 MB.
const wavLimitSize = intFromEnv('MAX_WAV_BYTES', 200_000_000)
// Anything else (e.g. opus) uses the same bound as WAV's old default. 150 MB.
const otherLimitSize = intFromEnv('MAX_OTHER_BYTES', 150_000_000)

// ---- Duration cap (seconds) ------------------------------------------------
// Max accepted audio duration (the clean cap, used for display). Default 24h.
const maxDurationSeconds = intFromEnv('MAX_DURATION_SECONDS', 24 * 60 * 60)
// Extra grace added on top of the cap before rejecting (absorbs rounding in
// reported durations). Default 60s.
const durationGraceSeconds = intFromEnv('MAX_DURATION_GRACE_SECONDS', 60)
// Whole limit incl. grace (used for the actual comparison).
const maxDurationWithGraceSeconds = maxDurationSeconds + durationGraceSeconds
// Clean hours value for user-facing messages.
const maxDurationHoursDisplay = maxDurationSeconds / 3600

// ---- ffmpeg timeouts (milliseconds) ----------------------------------------
// Whole-file convert (e.g. FLAC -> WAV, and per-segment WAV -> FLAC). A 24h
// FLAC decode is the slowest step. Default 30 min.
const convertTimeoutMs = intFromEnv('FFMPEG_CONVERT_TIMEOUT_MS', 30 * 60 * 1000)
// Segment split (stream-copy, fast even for long files). Default 15 min.
const splitTimeoutMs = intFromEnv('FFMPEG_SPLIT_TIMEOUT_MS', 15 * 60 * 1000)

/**
 * Returns the size cap (bytes) for a given file extension (no leading dot,
 * lower-cased), e.g. sizeLimitForExtension('flac').
 */
function sizeLimitForExtension (fileExtension) {
  if (fileExtension === 'flac') { return flacLimitSize }
  if (fileExtension === 'wav') { return wavLimitSize }
  return otherLimitSize
}

module.exports = {
  flacLimitSize,
  wavLimitSize,
  otherLimitSize,
  maxDurationSeconds,
  durationGraceSeconds,
  maxDurationWithGraceSeconds,
  maxDurationHoursDisplay,
  convertTimeoutMs,
  splitTimeoutMs,
  sizeLimitForExtension
}
