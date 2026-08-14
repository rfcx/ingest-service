/**
 * Recorder-provenance validation for historical (pre-epoch) recordings.
 *
 * WHY THIS EXISTS
 * ---------------
 * `routes/uploads.js` used to reject ANY timestamp before 1971. That blanket
 * rule conflated two very different things:
 *
 *   1. GENUINE historical material — digitised tape/archive recordings whose
 *      real date is 1955, 1941, 1900... These are legitimate and Arbimon's
 *      storage supports them (stream_segments.start is timestamptz; the
 *      TimescaleDB hypertable already holds 213 pre-epoch chunks).
 *
 *   2. UNSET RECORDER CLOCKS — a digital recorder whose battery died and whose
 *      clock restarted at the Unix epoch, producing a burst of files stamped
 *      1970-01-01 onwards. These are WRONG, and silently so.
 *
 * The operator's rule separates them by PROVENANCE rather than by date:
 * digital field recorders (AudioMoth, Song Meter, ...) did not exist before
 * 1971, so a file whose own metadata names one CANNOT genuinely predate that
 * date. A digitised archive recording, by contrast, carries no such metadata.
 *
 * MEASURED ON PRODUCTION (2026-08-13, core.stream_segments, 229,024 pre-1971
 * segments across 287 streams) — the rule separates the classes cleanly:
 *
 *   bucket                                segments   with recorder metadata
 *   epoch-drift window (12-31 .. 01-14)    220,985            59.0%
 *   rest of 1970                             7,321            95.7%
 *   plausible historical (1900..1969-11)       551             0.4%
 *   absurd (< 1900)                            167             0.0%
 *
 * Control: of 302,303 files ingested in the previous 30 days, 273,774 (90.6%)
 * carry recorder metadata — so its ABSENCE is meaningful, not just missing.
 *
 * The two apparent counter-examples were themselves misparsed files, and they
 * strengthen the rule: parsed start 1901-02-16, but the AudioMoth comment says
 * "Recorded at 06:00:00 17/02/2019" (filename `160219010101.WAV` — a DDMMYY
 * name read as YYMMDD). The rule rejects them, correctly, and the metadata
 * even supplies the true date.
 *
 * WHY NOT A DATE-WINDOW GUARD (an earlier proposal, discarded by evidence):
 * blocking 1969-12-31..1970-01-14 outright would destroy genuine archival
 * uploads. Real xeno-canto material sits INSIDE that window with placeholder
 * dates, e.g. `ChestnutRumpedBabblerXC360083dt19700101_000000.wav`
 * ("album":"xeno-canto", attributed recordists). Provenance keeps those; a
 * date window would not.
 */

/**
 * Signatures of digital field recorders. Matched case-insensitively against
 * the file's own container tags (ffprobe `format.tags`).
 *
 * Keep this list CONSERVATIVE: a false positive rejects a legitimate archive
 * upload. Every entry here is a device/format that demonstrably postdates
 * 1971 and appears in production metadata.
 */
const RECORDER_SIGNATURES = [
  { pattern: /AudioMoth/i, name: 'AudioMoth' },
  { pattern: /GUANO/, name: 'GUANO metadata (bioacoustic recorder)' },
  { pattern: /Song\s?Meter/i, name: 'Song Meter' },
  { pattern: /Wildlife\s?Acoustics/i, name: 'Wildlife Acoustics' },
  { pattern: /SongMeter/i, name: 'Song Meter' },
  { pattern: /Swift\s?Recorder/i, name: 'Swift' },
  { pattern: /Avisoft/i, name: 'Avisoft-RECORDER' },
  { pattern: /Zoom\s+H[1-9]/i, name: 'Zoom handheld recorder' }
]

/**
 * The earliest plausible recording date. Sound recording begins ~1860
 * (phonautogram) and practical field recording much later; anything before
 * this is a parse failure, not a recording. Production holds 167 such rows
 * (year 0218, 0306, 1501, ...), all from misparsed filenames.
 *
 * Env-overridable so it can be tuned without a rebuild.
 */
function intFromEnv (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') { return fallback }
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

const minRecordingYear = intFromEnv('MIN_RECORDING_YEAR', 1800)

/**
 * The year before which a DIGITAL RECORDER could not have produced audio.
 * Deliberately the same 1971 boundary the old blanket rule used, so behaviour
 * for recorder-tagged files is UNCHANGED; only untagged (archival) files gain
 * new freedom.
 */
const minDigitalRecorderYear = intFromEnv('MIN_DIGITAL_RECORDER_YEAR', 1971)

/**
 * Maximum tolerated disagreement (in days) between a timestamp and a date
 * embedded in the file's own metadata. Production shows misparsed filenames
 * off by ~110 years (parsed 1901-12-09 vs embedded "date":"2012-11-19"),
 * while legitimate timezone/rounding differences are hours at most.
 */
const maxMetadataDateDriftDays = intFromEnv('MAX_METADATA_DATE_DRIFT_DAYS', 366)

/**
 * Flatten ffprobe format tags to one searchable string.
 * Tags look like: { comment: 'Recorded at ... by AudioMoth ...',
 *                   artist: 'AudioMoth 248D...', encoder: 'Lavf61.7.100' }
 * @param {object} tags
 * @returns {string}
 */
function flattenTags (tags) {
  if (tags === null || tags === undefined || typeof tags !== 'object') { return '' }
  return Object.values(tags)
    .filter(v => typeof v === 'string' || typeof v === 'number')
    .join(' ; ')
}

/**
 * Identify the digital recorder named by a file's metadata, if any.
 * @param {object} tags ffprobe format.tags
 * @returns {string|null} recorder display name, or null when none is named
 */
function detectRecorder (tags) {
  const haystack = flattenTags(tags)
  if (haystack === '') { return null }
  for (const sig of RECORDER_SIGNATURES) {
    if (sig.pattern.test(haystack)) { return sig.name }
  }
  return null
}

/**
 * Extract a date embedded in the file's own metadata, when the container
 * carries one independent of the filename.
 *
 * Two shapes seen in production:
 *   - BWF/Avisoft: tags.date = "2012-11-19"
 *   - AudioMoth ICMT: "Recorded at HH:MM:SS DD/MM/YYYY (UTC...) by AudioMoth"
 *
 * @param {object} tags
 * @returns {Date|null} UTC date (day precision is sufficient here)
 */
function extractMetadataDate (tags) {
  const haystack = flattenTags(tags)
  if (haystack === '') { return null }

  // AudioMoth comment: DD/MM/YYYY
  const am = haystack.match(/Recorded at \d{2}:\d{2}:\d{2}(?:\.\d+)? (\d{2})\/(\d{2})\/(\d{4})/)
  if (am !== null) {
    const [, d, mo, y] = am
    const parsed = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    if (!isNaN(parsed.getTime())) { return parsed }
  }

  // BWF-style ISO date tag (Avisoft and friends): YYYY-MM-DD
  const iso = haystack.match(/(?:^|[^0-9])((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/)
  if (iso !== null) {
    const [, y, mo, d] = iso
    const parsed = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    if (!isNaN(parsed.getTime())) { return parsed }
  }

  return null
}

/**
 * Provenance-aware validation of a recording timestamp.
 *
 * Replaces the old blanket "reject anything before 1971" rule. Returns a
 * rejection reason string, or null when the timestamp is acceptable.
 *
 * @param {Date|object} timestamp recording start (Date or moment)
 * @param {object} tags ffprobe format.tags for the file (may be empty)
 * @returns {string|null} human-readable rejection reason, or null if OK
 */
function checkRecordingTimestamp (timestamp, tags) {
  const date = (timestamp instanceof Date) ? timestamp : new Date(timestamp.valueOf())
  if (isNaN(date.getTime())) { return 'Recording timestamp is not a valid date' }

  const year = date.getUTCFullYear()

  // 1. Absurdity floor — a parse failure, not a recording.
  if (year < minRecordingYear) {
    return `Recording date ${date.toISOString().slice(0, 10)} is before ${minRecordingYear}, which is not a plausible recording date (the filename or timestamp format is probably being misread)`
  }

  // 2. Provenance rule: a digital recorder cannot predate its own existence.
  if (year < minDigitalRecorderYear) {
    const recorder = detectRecorder(tags)
    if (recorder !== null) {
      return `This file's metadata says it was recorded by ${recorder}, which cannot predate ${minDigitalRecorderYear} — the recorder's clock was most likely unset (a dead battery restarts it at 1970-01-01). Correct the date, or re-upload after fixing the recorder clock.`
    }
  }

  // 3. Metadata contradiction: the file's own embedded date disagrees wildly.
  //    Catches misparsed filenames regardless of recorder brand.
  const metaDate = extractMetadataDate(tags)
  if (metaDate !== null) {
    const driftDays = Math.abs(date.getTime() - metaDate.getTime()) / 86400000
    if (driftDays > maxMetadataDateDriftDays) {
      return `The recording date ${date.toISOString().slice(0, 10)} disagrees with the date stored inside the file (${metaDate.toISOString().slice(0, 10)}) by ${Math.round(driftDays / 365.25)} years — the filename timestamp format is probably being misread`
    }
  }

  return null
}

module.exports = {
  checkRecordingTimestamp,
  detectRecorder,
  extractMetadataDate,
  minRecordingYear,
  minDigitalRecorderYear,
  maxMetadataDateDriftDays,
  RECORDER_SIGNATURES
}
