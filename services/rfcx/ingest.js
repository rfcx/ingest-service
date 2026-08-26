const platform = process.env.PLATFORM || 'amazon'

const storage = require(`../storage/${platform}`)
const db = require('../db/uploads')
const audioService = require('../audio')
const dirUtil = require('../../utils/dir')
const segmentService = require('../rfcx/segments')
const { chunks } = require('../../utils/array')
const { getKeyByValue } = require('../../utils/obj')
const { PROMETHEUS_ENABLED, registerHistogram, pushHistogramMetric } = require('../../services/prometheus')
const path = require('path')
const fs = require('fs')
const moment = require('moment-timezone')
const { v4: uuidv4 } = require('uuid')
const TimeTracker = require('../../utils/time-tracker')
const uploadBucket = process.env.UPLOAD_BUCKET
const ingestBucket = process.env.INGEST_BUCKET
const errorBucket = process.env.ERROR_BUCKET
const uploadTargets = require('../uploads/upload-targets')

// Accepted upload formats.
//
// AIFF (2026-08-14): added as a LOSSLESS format, handled exactly like FLAC --
// decoded to WAV, split, then each segment encoded to FLAC. Measured against
// the production ffmpeg (4.4.2) on 125s and 1200s fixtures: span drift 0.000s
// at every duration tested, identical to WAV/FLAC, across standard 16-bit BE,
// 24-bit, AIFF-C `sowt` (little-endian) and the 3-letter `.aif` spelling.
// Both spellings are accepted because recorders and Mac tooling emit each.
const supportedExtensions = ['.wav', '.flac', '.opus', '.aiff', '.aif']
const losslessExtensions = ['.wav', '.flac', '.aiff', '.aif']
const extensionsRequiringConvToWav = ['.flac', '.aiff', '.aif']

const { IngestionError } = require('../../utils/errors')
const { checkRecordingTimestamp } = require('../../utils/recorder-provenance')
const { maxDurationWithGraceSeconds, maxDurationHoursDisplay } = require('../../utils/limits')
const { retryOnPutLimit } = require('../../utils/put-retry')
const loggerIgnoredErrors = [
  /Duplicate file\. Matching sha1 signature already ingested\./,
  /This file was already ingested\./,
  /File extension is not supported/,
  /Stream source file was not created/,
  /Cannot create source file with provided data/,
  /There is another file with the same timestamp in the stream/,
  // Unreadable/empty/truncated media (2026-08-21): a terminal USER-side data
  // problem, not a platform fault. The raw ffprobe diagnostic is logged
  // separately at the throw site, so this only suppresses the duplicate
  // error-level line in the generic handler.
  /Audio file could not be read/
]

if (PROMETHEUS_ENABLED) {
  // create historgram for each available file format
  supportedExtensions.forEach((ext) => {
    const name = ext.substr(1)
    registerHistogram(name, `Processing metric for ${name} format.`)
  })
  Object.keys(db.status).forEach((s) => {
    registerHistogram(s, `${s} upload status.`, [1, 2, 3, 4, 5, 10, 50, 100, 250, 500, 1000, 2000])
  })
  // Segment-PUT bulkhead-retry observability (2026-08-19): the capacity
  // decision that led to the s3-writer-ingest KEDA floor/cap had to be made
  // from log greps. Count retries and exhaustions so the next one is made
  // from data. House convention: histograms pushed with value 1 act as
  // counters (same as the status metrics above).
  registerHistogram('put_limit_retry', 'Segment PUTs retried after an s3-writer in-flight PUT limit rejection.', [1, 2, 3, 4, 5, 10, 50, 100, 250, 500, 1000, 2000])
  registerHistogram('put_limit_exhausted', 'Segment PUTs that exhausted all put-limit retries and failed the ingest.', [1, 2, 3, 4, 5, 10, 50, 100, 250, 500, 1000, 2000])
}

/**
 * Returns directory path for stream on a disk
 * @param {*} fileStoragePath
 */
function getStreamLocalPath (fileStoragePath) {
  return path.join(process.env.CACHE_DIRECTORY, path.dirname(fileStoragePath))
}

/**
 * Returns path for a file on a disk
 * @param {*} fileStoragePath
 */
function getFileLocalPath (fileStoragePath) {
  return path.join(process.env.CACHE_DIRECTORY, fileStoragePath)
}

/**
 * Creates a directory for stream
 * @param {*} streamLocalPath
 * @returns
 */
function createStreamLocalPath (streamLocalPath) {
  return dirUtil.ensureDirExists(streamLocalPath)
}

/**
 * Checks if file extension is supported by the Ingest Service. Throws IngestionError if not.
 * @param {string} extension
 */
function validateFileFormat (extension) {
  if (!supportedExtensions.includes(extension)) {
    throw new IngestionError('File extension is not supported', db.status.FAILED)
  }
}

/**
 * Checks file metadata. Throws IngestionError if data is invalid.
 * @param {*} upload - upload object received from database
 * @param {*} meta -
 * @param {*} extension
 */
function validateAudioMeta (upload, meta, extension) {
  // Provenance-aware date check. This is the ONLY point in the pipeline where
  // the file's own metadata is available (ffprobe format.tags), so it is where
  // the "a digital recorder cannot predate 1971" rule can actually be applied.
  // The upload API can only enforce the absurdity floor (no bytes yet).
  // Genuine digitised archives carry no recorder tags and pass freely.
  const timestampProblem = checkRecordingTimestamp(upload.timestamp, meta.tags)
  if (timestampProblem !== null) {
    throw new IngestionError(timestampProblem)
  }
  if (isNaN(meta.duration) || meta.duration === 0) {
    throw new IngestionError('Audio duration is zero')
  }
  if (meta.duration > maxDurationWithGraceSeconds) {
    throw new IngestionError(`Audio duration is more than ${maxDurationHoursDisplay} hours`)
  }
  if (isNaN(meta.sampleCount) || meta.sampleCount === 0) {
    throw new IngestionError('Audio sampleCount is zero')
  }
  if (upload.checksum && upload.checksum !== meta.checksum) {
    throw new IngestionError('Checksum mismatch.', db.status.CHECKSUM)
  }
}

/**
 * Splits source file into segments and converts them to flac if file is lossless
 * @param {*} filePath
 * @param {*} fileData
 * @returns
 */
async function transcode (filePath, fileData) {
  const fileExtension = path.extname(filePath).toLowerCase()
  const isLosslessFile = losslessExtensions.includes(fileExtension)
  let destinationFilePath = filePath
  if (extensionsRequiringConvToWav.includes(fileExtension)) {
    destinationFilePath = filePath.replace(path.extname(filePath), '.wav')
    var { meta } = await audioService.convert(filePath, destinationFilePath) // eslint-disable-line no-var
  }
  console.info('Splitting original file into segments')
  const segmentDuration = fileData.duration >= 120 ? 60 : 120
  const outputFiles = await audioService.split(destinationFilePath, path.dirname(filePath), segmentDuration)
  console.info(`File was split into ${outputFiles.length} segments`)

  if (isLosslessFile) { // convert lossless files to flac format
    for (const file of outputFiles) {
      const finalPath = file.path.replace(path.extname(file.path), '.flac')
      const { meta: flacMeta } = await audioService.convert(file.path, finalPath)
      file.path = finalPath
      // Refresh the segment's byte size from the FLAC we actually store.
      //
      // `file.meta` was probed from the pre-conversion WAV segment, so without
      // this the size reported to Core (and thence to Arbimon's
      // recordings.file_size) is the UNCOMPRESSED size -- a constant
      // samples*2 + header for every 60s segment, ~30-40% larger than the FLAC
      // that is actually uploaded. Observed live 2026-08-21: 97 recordings all
      // reported 5760258 bytes while the stored objects ranged 3.3-4.3 MB.
      //
      // ONLY the size is refreshed. duration/sampleCount are deliberately left
      // alone: they are corrected upstream by the decode-vs-probe reconciliation
      // in audioService.split() (the cumulative-opus-timestamp fix), and
      // re-probing here would discard that correction.
      // Coerced rather than checked with Number.isFinite() directly: ffprobe
      // reports format.size as a NUMBER in the build we ship (verified in the
      // running pod: typeof 'number'), but returns it as a STRING in many other
      // builds. A strict check would then silently skip the refresh and leave
      // the WAV size in place -- a fix that quietly does nothing is worse than
      // no fix, because it looks applied.
      const flacSize = flacMeta ? Number(flacMeta.size) : NaN
      if (Number.isFinite(flacSize) && flacSize > 0) {
        file.meta.size = flacSize
      } else {
        console.warn(`[transcode] could not read FLAC size for ${finalPath}; keeping probed size ${file.meta && file.meta.size}`)
      }
    }
  }
  return {
    wavMeta: meta,
    outputFiles
  }
}

function setAdditionalFileAttrs (outputFiles, upload) {
  const timestamp = moment.tz(upload.timestamp, 'UTC').valueOf()
  let totalDurationMs = 0
  for (const file of outputFiles) {
    const duration = Math.floor(file.meta.duration * 1000)
    const ts = moment.tz(timestamp, 'UTC').add(totalDurationMs, 'milliseconds')
    file.start = ts.toISOString()
    file.end = ts.clone().add(duration, 'milliseconds').toISOString()
    totalDurationMs += duration
  }
}

function setFilesIdAndPath (outputFiles, data, streamId) {
  for (const file of outputFiles) {
    const dataItem = data.find(d => file.start === d.start)
    file.guid = dataItem.id
    const ts = moment.utc(file.start)
    file.remotePath = `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${streamId}/${file.guid}${path.extname(file.path)}`
    dataItem.remotePath = file.remotePath
  }
}

/**
 * Mint each segment's id and storage key BEFORE anything is written.
 *
 * WHY. Core rows used to be created first, and the S3 key was derived from the
 * uuid Core minted (setFilesIdAndPath above). That ordering opens a window in
 * which the database advertises audio that has not been written yet. Normally
 * the window is ~1s; on 2026-08-21 a hot-tier PUT blocked 92.6s, its retries
 * were rejected by s3-writer's in-flight PUT bulkhead (503 put-sem-timeout),
 * the worker never reached its catch{} rollback, and the window stayed open
 * permanently -- 44 segments were left advertised-but-absent.
 *
 * Minting locally inverts the failure mode: if the durable write fails there is
 * no Core row at all, so the upload simply fails and the user retries. The
 * worst case becomes an ORPHANED OBJECT (audio in storage, no row), which is
 * harmless and reclaimable, instead of an orphaned row, which is user-visible
 * data loss.
 *
 * WHY THIS IS SAFE:
 *  - `id` already flows end to end: combineSegmentsData sends `id: file.guid`
 *    and Core's post.js spreads `{ ...s }` into bulkCreate. Today file.guid is
 *    undefined at that point, JSON drops the key, and Core falls back to its
 *    own UUIDV4 default.
 *  - Sequelize 5.22.5 honours an explicitly supplied id (verified empirically
 *    against this exact version: supplied id kept, omitted id still
 *    auto-filled, unknown keys ignored).
 *  - The storage PATH never depended on the id: Core's calcSegmentDirname()
 *    uses only start + stream_id, and the id is appended separately. So the
 *    key we compute here is byte-identical to the one Core would compute.
 *  - Re-POST stays idempotent: post.js matches existing segments by
 *    (stream, starts) and updates availability rather than duplicating.
 */
function mintFilesIdAndPath (outputFiles, streamId) {
  for (const file of outputFiles) {
    file.guid = uuidv4()
    const ts = moment.utc(file.start)
    file.remotePath = `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${streamId}/${file.guid}${path.extname(file.path)}`
  }
}

/**
 * Find segments where Core returned an id different from the one we minted.
 *
 * This happens on Core's dedup path only: post.js looks up existing segments by
 * (stream, starts) and, for a match, returns the EXISTING row and merely sets
 * availability=1 — the supplied id is ignored. Since the audio has already been
 * written under our minted key, the caller must copy it to Core's key or the
 * row would reference a nonexistent object.
 *
 * Returns [{ start, from, to }] for the mismatches; [] on the normal path.
 */
function reconcileCoreSegmentIds (outputFiles, coreSegments, streamId) {
  const out = []
  for (const file of outputFiles) {
    const dataItem = (coreSegments || []).find(d => file.start === d.start)
    if (!dataItem || !dataItem.id || dataItem.id === file.guid) {
      continue
    }
    const ts = moment.utc(file.start)
    const ext = path.extname(file.path)
    out.push({
      start: file.start,
      from: file.remotePath,
      to: `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${streamId}/${dataItem.id}${ext}`
    })
  }
  return out
}

/**
 * Prepares source file data based on multiple sources
 * @param {*} fileLocalPath
 * @param {*} fileData
 * @param {*} fileDataWav
 * @param {*} upload
 */
function combineSourceFileData (fileData, wavMeta, upload) {
  const data = { ...fileData }
  data.stream = upload.streamId
  data.filename = upload.originalFilename
  if (wavMeta) {
    data.bitRate = wavMeta.bitRate
    data.duration = wavMeta.duration
  }
  // if sampleRate and bitRate were specified on upload request, then set them implicitly
  if (upload.sampleRate) { data.sampleRate = upload.sampleRate }
  if (upload.targetBitrate) { data.bitRate = upload.targetBitrate }
  return data
}

/**
 * Prepares segments data based on output files
 * @param {*} outputFiles
 * @param {*} upload
 */
function combineSegmentsData (outputFiles, upload) {
  const combinedData = outputFiles.map((file) => {
    return {
      id: file.guid,
      stream: upload.streamId,
      start: file.start,
      end: file.end,
      sampleCount: file.meta.sampleCount,
      fileExtension: path.extname(file.path),
      fileSize: file.meta.size
    }
  })
  return combinedData
}

/**
 * Prepares payload data needed for source files and segments creation in Core API
 * @param {*} fileLocalPath
 * @param {*} fileData
 * @param {*} fileDataWav
 * @param {*} outputFiles
 * @param {*} upload
 */
function combineCorePayloadData (fileData, wavMeta, outputFiles, upload) {
  return {
    streamSourceFile: combineSourceFileData(fileData, wavMeta, upload),
    streamSegments: combineSegmentsData(outputFiles, upload)
  }
}

function buildIngestionResult (coreData, outputFiles, upload) {
  const source = coreData && coreData.streamSourceFile ? coreData.streamSourceFile : {}
  const segments = Array.isArray(coreData && coreData.streamSegments) ? coreData.streamSegments : []
  const filesById = new Map(outputFiles.map(file => [file.guid, file]))
  return {
    streamSourceFileId: source.id,
    streamId: upload.streamId || source.streamId || source.stream_id,
    projectId: upload.projectId || source.projectId || source.project_id,
    siteId: source.siteId || source.site_id,
    arbimonProjectId: source.arbimonProjectId || source.arbimon_project_id,
    arbimonSiteId: source.arbimonSiteId || source.arbimon_site_id,
    ingestedAt: moment.utc().toDate(),
    segments: segments.map(segment => {
      const file = filesById.get(segment.id) || {}
      return {
        id: segment.id,
        start: segment.start,
        end: segment.end || file.end,
        path: segment.remotePath || file.remotePath
      }
    })
  }
}

async function ingest (fileStoragePath, fileLocalPath, streamId, uploadId) {
  let tracker = new TimeTracker('IngestTask')
  let outputFiles = []
  let coreData = {}
  let upload = null
  let uploadSource = null
  // Tracks whether THIS invocation owns the ingest claim, so the catch block
  // only releases a claim it actually took (see the release call there).
  let claimHeld = false
  const streamLocalPath = getStreamLocalPath(fileStoragePath)
  try {
    const startTimestamp = Date.now() // is used for processing time calculation
    const fileExtension = path.extname(fileStoragePath).toLowerCase()

    validateFileFormat(fileExtension)

    // ---------------------------------------------------------------------
    // IDEMPOTENCY GATE -- duplicate EVENT delivery (2026-08-26).
    //
    // The upstream R2 -> CF Queue -> bridge -> webhook -> RabbitMQ path is
    // at-least-once and fans out hard: measured over a live user burst, 1460
    // ObjectCreated events for 204 distinct objects (mean 7.16, max 42), every
    // duplicate reporting an IDENTICAL byte size. Each one is a GENUINE,
    // DISTINCT queue message, so it cannot be suppressed by consumer-side
    // dedup -- 151 upload ids were consumed more than once by the SAME pod.
    //
    // This claim is taken BEFORE the download, because the download is the
    // dominant wasted cost (7.33 R2 GETs per file, billed egress) and every
    // later guard -- the pre-transcode dedup check and createStreamFileData --
    // only arbitrates AFTER the transcode and segment PUTs have been paid for.
    //
    // Losing the claim is a NORMAL outcome, not an error: it means another
    // delivery of the same object is being handled (or already completed), so
    // we return quietly and the caller ACKs. Throwing here would dead-letter
    // routine duplicates and manufacture a DLQ backlog.
    //
    // Degrades safely: the Mongo upload store (frozen, mongo2pg §67) does not
    // implement the claim, so an unsupported backend simply proceeds as before.
    // Record: runbooks/INCIDENT-2026-08-26-r2-event-fanout-duplicate-ingest.md
    // ---------------------------------------------------------------------
    if (typeof db.claimUploadForIngest === 'function') {
      const claim = await db.claimUploadForIngest(uploadId)
      if (!claim.claimed) {
        if (claim.reason === 'ingested') {
          console.info(`[${uploadId}] Duplicate event for an already-INGESTED upload; skipping re-ingest`)
        } else if (claim.reason === 'in-flight') {
          console.info(`[${uploadId}] Duplicate event while another worker holds the ingest claim (status ${claim.status}); skipping`)
        } else {
          console.info(`[${uploadId}] Ingest claim not granted (${claim.reason}); skipping`)
        }
        if (PROMETHEUS_ENABLED) { pushHistogramMetric('duplicate_event_skipped', 1) }
        claimHeld = false
        return
      }
      claimHeld = true
    }

    upload = await db.getUpload(uploadId)
    uploadSource = uploadTargets.sourceFromUpload(upload, fileStoragePath)
    console.info(`[${uploadId}] Upload metadata from database `, JSON.stringify(upload))
    await createStreamLocalPath(streamLocalPath)
    console.info(`[${uploadId}] Downloading file from storage`)
    tracker.setPoint()
    await storage.download(fileStoragePath, getFileLocalPath(fileStoragePath), uploadSource)
    tracker.logAndSetNewPoint(`[${uploadId}] downloaded file`)
    console.info(`[${uploadId}] Updating upload status to UPLOADED`)
    await db.updateUploadStatus(uploadId, db.status.UPLOADED)
    tracker.logAndSetNewPoint(`[${uploadId}] updated upload status in upload store`)

    // ffprobe failure here means the BYTES ARE NOT DECODABLE AS AUDIO -- a
    // truncated/empty/garbage upload. That is PERMANENT: re-running the exact
    // same object through the exact same probe cannot succeed. Classify it as
    // a terminal IngestionError so it is ACK-dropped and the upload reports
    // `review_error`, NOT the generic "try again later" message.
    //
    // WHY THIS MATTERS (2026-08-21, OPEN-ITEMS #196): the generic message is
    // the one string routes/uploads.js:isRetryableUpload() treats as RETRYABLE,
    // so nextActionForUpload() answered `retry_upload` and the client dutifully
    // re-uploaded FOREVER. One 131072-byte all-zeros file produced 330 upload
    // rows in 12h (~2.1/min, still climbing) and ~308 DLQ messages/hour. The
    // client was not misbehaving -- it was obeying the API. Every retry cost an
    // R2 GET + ffprobe + DB writes, and the DLQ depth it created was
    // simultaneously (mis)driving KEDA autoscaling.
    //
    // Scope deliberately narrow, TWICE OVER:
    //   1. only the probe-the-source call is wrapped; and
    //   2. only when the downloaded file is actually PRESENT ON DISK.
    // A missing/unstatable local file means the DOWNLOAD failed -- that is an
    // infrastructure fault, not bad user data, and it must keep the old
    // behaviour (generic retryable message + dead-letter for redrive). Without
    // this guard a failed download would be blamed on the user's audio and
    // silently ACK-dropped, losing the redrive path.
    let localSize = -1
    try {
      localSize = fs.statSync(fileLocalPath).size
    } catch (_) {
      localSize = -1
    }
    let fileData
    try {
      fileData = await audioService.identify(fileLocalPath)
    } catch (probeErr) {
      if (localSize < 0) {
        // Download/staging problem -> transient. Re-throw untouched.
        throw probeErr
      }
      // Keep the raw ffprobe diagnostic in the logs for operators; the user
      // sees the actionable message below, not ffmpeg internals.
      console.error(
        `[${uploadId}] Unreadable media: ffprobe failed on ${fileExtension || 'unknown'} ` +
        `source: ${probeErr && probeErr.message}`
      )
      throw new IngestionError(
        `Audio file could not be read (${fileExtension || 'unknown format'}). ` +
        'The uploaded file is empty, truncated or not valid audio. ' +
        'Re-uploading the same file will not help -- please check the source ' +
        'file on the recorder and upload it again.',
        db.status.FAILED
      )
    }
    tracker.logAndSetNewPoint(`[${uploadId}] identified file with ffmpeg`)
    console.info(`[${uploadId}] Audio metadata`, JSON.stringify(fileData))
    validateAudioMeta(upload, fileData, fileExtension)

    // Pre-transcode duplicate check (optimization). The original-file sha1
    // (fileData.checksum) is known here, before the expensive transcode +
    // 60-segment upload. If Core already has a stream source file with this
    // sha1 at this timestamp, the file was already ingested -> skip straight
    // to the duplicate outcome (the catch block marks status, preserves the
    // R2 source for lifecycle expiry, and acks). This is a perf optimization only; the authoritative
    // dedup remains the post-transcode createStreamFileData call below, which
    // also guards the concurrent-worker race (two workers may both pass this
    // pre-check before either has created the source file).
    // Apply the SAME duplicate test as the upload API's pre-upload check
    // (routes/uploads.js): an existing source file matched by sha1 + start,
    // that already has segments whose first segment start equals this
    // timestamp (within 1s) and is available (availability !== 0), is a
    // genuine already-ingested duplicate. (availability === 0 means the
    // existing file was deleted/unavailable, so a re-ingest is allowed --
    // we must NOT skip in that case.) Only skip the transcode on a true dup;
    // the post-transcode createStreamFileData call remains authoritative.
    const existingSrc = await segmentService.findIngestedDuplicate(
      upload.streamId, fileData.checksum, moment.tz(upload.timestamp, 'UTC')
    )
    if (existingSrc && existingSrc.id) {
      const ts = moment.tz(upload.timestamp, 'UTC').valueOf()
      const hasSegments = existingSrc.segments && existingSrc.segments.length
      const sameFile = hasSegments && Math.abs(moment.utc(existingSrc.segments[0].start).valueOf() - ts) < 1000
      if (sameFile && existingSrc.availability !== 0) {
        console.info(`[${uploadId}] Pre-transcode dedup: sha1 already ingested (source_file ${existingSrc.id}); skipping transcode`)
        throw new IngestionError('Duplicate file. Matching sha1 signature already ingested.', db.status.DUPLICATE)
      }
    }
    tracker.logAndSetNewPoint(`[${uploadId}] pre-transcode dedup check`)

    console.info(`[${uploadId}] Transcoding file`)
    tracker.setPoint()
    const transcodeData = await transcode(fileLocalPath, fileData)
    tracker.logAndSetNewPoint(`[${uploadId}] transcoded file`)
    outputFiles = transcodeData.outputFiles
    setAdditionalFileAttrs(outputFiles, upload)

    // Mint ids + storage keys locally so the durable write can happen BEFORE
    // Core rows exist. See mintFilesIdAndPath() for the full rationale and the
    // evidence that Core honours a client-supplied id.
    mintFilesIdAndPath(outputFiles, upload.streamId)

    console.info(`[${uploadId}] Uploading segments`)
    tracker.setPoint()
    let processedSegCount = 0
    for (const chunk of [...chunks(outputFiles, 5)]) {
      // Each segment PUT retries ONLY the s3-writer's in-flight PUT bulkhead
      // rejection (503 SlowDown "in-flight PUT limit reached; retry") with
      // bounded jittered backoff — see utils/put-retry.js for the 2026-08-19
      // incident and the >5s-per-attempt rationale (the writer's own acquire
      // window is 5s, so each retry sees a fresh window). ANY other error
      // still fails fast on the first attempt, and an exhausted retry
      // re-throws the last throttle error raw — so the rollback + status 30 +
      // nack->DLQ path below is byte-identical to before for every non-
      // throttle failure and for genuine sustained saturation. The retry
      // wraps ONLY this PUT phase: segment keys (f.remotePath) are minted
      // LOCALLY before this loop (mintFilesIdAndPath) and are stable across
      // attempts, so a re-PUT is an idempotent overwrite; the queue message is
      // not acked until the whole ingest settles (consumer semantics
      // untouched).
      await Promise.all(chunk.map((f) => {
        return retryOnPutLimit(
          () => storage.upload(ingestBucket, f.remotePath, f.path),
          {
            onRetry: ({ attempt, delayMs, error }) => {
              console.warn(`[${uploadId}] s3-writer PUT limit hit for ${f.remotePath} (attempt ${attempt}); retrying in ${delayMs}ms: ${error && error.message}`)
              if (PROMETHEUS_ENABLED) { pushHistogramMetric('put_limit_retry', 1) }
            },
            onExhausted: (error) => {
              console.error(`[${uploadId}] s3-writer PUT limit retries exhausted for ${f.remotePath}: ${error && error.message}`)
              if (PROMETHEUS_ENABLED) { pushHistogramMetric('put_limit_exhausted', 1) }
            }
          }
        ).then((data) => {
          if (!data || !data.ETag) {
            throw new Error('Error while uploading file to storage')
          }
        })
      }))
      processedSegCount += chunk.length
      console.info(`[${uploadId}] Processed ${processedSegCount} recordings of ${outputFiles.length}`)
    }
    tracker.logAndSetNewPoint(`[${uploadId}] uploaded al segments to S3`)

    // Core rows are created ONLY after every segment is durably written, using
    // the ids minted above. A failure before this point leaves no row at all.
    const corePayload = combineCorePayloadData(fileData, transcodeData.wavMeta, outputFiles, upload)
    tracker.setPoint()
    coreData = await segmentService.createStreamFileData(upload.streamId, corePayload)
    tracker.logAndSetNewPoint(`[${uploadId}] created data in Core API`)

    // ⚠️ Core is authoritative about ids, and it does NOT always return ours.
    // post.js matches pre-existing segments by (stream, start): for those it
    // returns the EXISTING row's id and only flips availability=1, ignoring the
    // id we supplied. Our audio is already written under the MINTED key, so a
    // silent re-sync here would leave Core pointing at a key that does not
    // exist — precisely the advertised-but-absent bug this change removes.
    //
    // Reconcile explicitly: adopt Core's id, and where it differs from ours,
    // copy the object to the id Core actually stored so the row and the object
    // agree. This is the rare dedup path, not the hot path.
    const reconciled = reconcileCoreSegmentIds(outputFiles, coreData.streamSegments, upload.streamId)
    for (const r of reconciled) {
      console.warn(`[${uploadId}] Core returned a pre-existing segment id for start=${r.start}; copying ${r.from} -> ${r.to}`)
      await storage.copy(`${ingestBucket}/${r.from}`, ingestBucket, r.to)
    }
    setFilesIdAndPath(outputFiles, coreData.streamSegments, upload.streamId)

    console.info(`[${uploadId}] Modifying status to INGESTED (${db.status.INGESTED})`)
    await db.updateUploadStatus(uploadId, db.status.INGESTED, null, buildIngestionResult(coreData, outputFiles, upload))
    tracker.logAndSetNewPoint(`[${uploadId}] updated upload status in upload store`)

    if (PROMETHEUS_ENABLED && fileData.sampleCount) {
      console.info(`[${uploadId}] Updating processing metrics`)
      const processingValue = (Date.now() - startTimestamp) / fileData.sampleCount * 10000 // we use multiplier because values are far less than 1 in other case
      pushHistogramMetric(fileExtension.substr(1), processingValue)
      tracker.logAndSetNewPoint(`[${uploadId}] pushed histogram metric`)
    }
    console.info(`[${uploadId}] Cleaning up local files`)
    // Do not explicitly delete the original upload object from uploadBucket.
    // It remains available for duplicate/stale deliveries and operator DLQ
    // redrive, and is reaped by the Cloudflare R2 lifecycle rule instead.
    await dirUtil.removeDirRecursively(streamLocalPath)
    tracker.logAndSetNewPoint(`[${uploadId}] cleaned up local files`)
    tracker = null
    return { outcome: 'ingested', uploadId }
  } catch (err) {
    /**
     * ERROR HANDLING
     */
    if (loggerIgnoredErrors.some((r) => { return r.test(err.message) })) {
      console.warn(`[${uploadId}] Warn for upload ${uploadId} ${err.message}`)
    } else {
      console.error(`[${uploadId}] Error for upload ${uploadId} ${err.message}`)
    }
    const message = err instanceof IngestionError ? err.message : 'Server failed with processing your file. Please try again later.'
    const status = err instanceof IngestionError ? err.status : db.status.FAILED
    // A "handled terminal" outcome is one we have fully recorded against
    // the upload (status written below) and that re-processing will never
    // resolve: duplicates, already-ingested, checksum mismatch, unsupported
    // format, and size/duration validation failures. These are NOT message
    // failures — the consumer should ACK-drop them, not dead-letter them.
    // Anything else (transient: network/storage/Core 5xx, etc.) is re-thrown
    // so the consumer nacks-no-requeue to the DLQ for inspection/redrive.
    const handledTerminalStatuses = [db.status.INGESTED, db.status.DUPLICATE, db.status.CHECKSUM, db.status.FAILED]
    const isHandledTerminal = err instanceof IngestionError && handledTerminalStatuses.includes(status)
    await db.updateUploadStatus(uploadId, status, message)
    if (PROMETHEUS_ENABLED) {
      pushHistogramMetric(getKeyByValue(db.status, status), 1)
    }
    for (const file of outputFiles) {
      try {
        if (file.remotePath) {
          console.info(`[${uploadId}] Rollback: deleting file ${file.remotePath}`)
          await storage.deleteObject(ingestBucket, file.remotePath)
        }
      } catch (e) {
        console.info(`[${uploadId}] Rollback: failed deleting file ${file.remotePath}`, e)
      }
    }
    // Only roll back Core data if we actually created it. coreData starts
    // as {} (truthy), and the pre-transcode dedup path throws BEFORE
    // createStreamFileData runs, so guard on streamSourceFile.id — otherwise
    // both the delete call and its own error-log line dereference undefined
    // and throw out of the catch, turning a handled-terminal duplicate into
    // a nack -> DLQ.
    if (coreData && coreData.streamSourceFile && coreData.streamSourceFile.id) {
      try {
        await segmentService.deleteStreamSourceFile(streamId, coreData)
      } catch (e) {
        console.info(`[${uploadId}] Rollback: failed deleting stream source file ${coreData.streamSourceFile.id}: ${e && e.message}`)
      }
    }

    // Optionally archive the failed upload + a .txt error log into a dedicated
    // error bucket so ops can inspect failures. When the upload source has its
    // own provider/endpoint (e.g. Cloudflare R2) we stream source -> destination
    // instead of using S3 server-side CopyObject, because cross-provider copy is
    // not portable.
    const configuredErrorBucket = process.env.ERROR_BUCKET || errorBucket
    if (process.env.ERROR_BUCKET_ENABLED === 'true' && configuredErrorBucket && !loggerIgnoredErrors.some((r) => r.test(message))) {
      try {
        if (uploadSource && uploadSource.bucket) {
          await storage.copyFromSource(uploadSource, configuredErrorBucket, fileStoragePath)
        } else {
          const sourceBucket = uploadBucket
          await storage.copy(`${sourceBucket}/${fileStoragePath}`, configuredErrorBucket, fileStoragePath)
        }
        // create error log text file in the same bucket
        const storageErrorFilePath = fileStoragePath.replace(path.extname(fileStoragePath), '.txt')
        await storage.createFromData(configuredErrorBucket, storageErrorFilePath, `message: ${err.message}\n\nstack: ${err.stack}`)
      } catch (errOnErrorCopy) {
        console.warn(`[${uploadId}] Failed to archive error blob to ${configuredErrorBucket}: ${errOnErrorCopy.message}`)
      }
    }

    // Do not explicitly delete the original upload from uploadBucket on either
    // handled-terminal or transient outcomes. The upload object is intentionally
    // kept for duplicate/stale deliveries and operator DLQ redrive, then reaped
    // by the Cloudflare R2 lifecycle rule. This avoids races where a successful
    // or terminal delivery deletes the source before a later duplicate/stale
    // message can be ACK-dropped cleanly.
    console.info(`[${uploadId}] Cleanup: preserving source upload ${fileStoragePath} for lifecycle expiry`)
    // Local scratch dir is always safe to remove (re-created from the upload
    // object on redrive if needed).
    try {
      await dirUtil.removeDirRecursively(streamLocalPath)
    } catch (e) {
      console.info(`[${uploadId}] Cleanup: failed removing local dir ${streamLocalPath}: ${e.message}`)
    }

    if (isHandledTerminal) {
      // Fully recorded + non-retryable: signal success so the consumer
      // ACK-drops the message instead of dead-lettering it.
      return { outcome: 'handled-terminal', status, message, uploadId }
    }

    // TRANSIENT failure -> this message is going to the DLQ for redrive, so the
    // ingest claim MUST be released. Leaving it held would make a later
    // operator redrive (or a duplicate delivery that could have succeeded) a
    // silent no-op until the TTL expired -- turning a recoverable fault into an
    // invisible one, which is precisely the class of bug this whole change
    // exists to remove. Terminal outcomes deliberately do NOT release: the row
    // is settled and must stay claimed against further duplicate deliveries.
    if (claimHeld && typeof db.releaseIngestClaim === 'function') {
      await db.releaseIngestClaim(uploadId)
    }
    // Transient / unexpected failure: re-throw so the consumer nacks the
    // message (nack-no-requeue -> DLQ).
    throw err
  }
}

module.exports = { ingest }
