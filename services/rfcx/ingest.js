const platform = process.env.PLATFORM || 'amazon'

const storage = require(`../storage/${platform}`)
const db = require('../db/mongo')
const audioService = require('../audio')
const dirUtil = require('../../utils/dir')
const segmentService = require('../rfcx/segments')
const { chunks } = require('../../utils/array')
const { getKeyByValue } = require('../../utils/obj')
const { PROMETHEUS_ENABLED, registerHistogram, pushHistogramMetric } = require('../../services/prometheus')
const path = require('path')
const moment = require('moment-timezone')
const TimeTracker = require('../../utils/time-tracker')
const uploadBucket = process.env.UPLOAD_BUCKET
const ingestBucket = process.env.INGEST_BUCKET
const errorBucket = process.env.ERROR_BUCKET
const uploadTargets = require('../uploads/upload-targets')

const supportedExtensions = ['.wav', '.flac', '.opus']
const losslessExtensions = ['.wav', '.flac']
const extensionsRequiringConvToWav = ['.flac']

const { IngestionError } = require('../../utils/errors')
const { maxDurationWithGraceSeconds, maxDurationHoursDisplay } = require('../../utils/limits')
const loggerIgnoredErrors = [
  /Duplicate file\. Matching sha1 signature already ingested\./,
  /This file was already ingested\./,
  /File extension is not supported/,
  /Stream source file was not created/,
  /Cannot create source file with provided data/,
  /There is another file with the same timestamp in the stream/
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
      await audioService.convert(file.path, finalPath)
      file.path = finalPath
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
  const streamLocalPath = getStreamLocalPath(fileStoragePath)
  try {
    const startTimestamp = Date.now() // is used for processing time calculation
    const fileExtension = path.extname(fileStoragePath).toLowerCase()

    validateFileFormat(fileExtension)
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
    tracker.logAndSetNewPoint(`[${uploadId}] updated upload status in Mongo`)

    const fileData = await audioService.identify(fileLocalPath)
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

    const corePayload = combineCorePayloadData(fileData, transcodeData.wavMeta, outputFiles, upload)
    tracker.setPoint()
    coreData = await segmentService.createStreamFileData(upload.streamId, corePayload)
    tracker.logAndSetNewPoint(`[${uploadId}] created data in Core API`)

    setFilesIdAndPath(outputFiles, coreData.streamSegments, upload.streamId)

    console.info(`[${uploadId}] Uploading segments`)
    tracker.setPoint()
    let processedSegCount = 0
    for (const chunk of [...chunks(outputFiles, 5)]) {
      await Promise.all(chunk.map((f) => {
        return storage.upload(ingestBucket, f.remotePath, f.path)
          .then((data) => {
            if (!data || !data.ETag) {
              throw new Error('Error while uploading file to storage')
            }
          })
      }))
      processedSegCount += chunk.length
      console.info(`[${uploadId}] Processed ${processedSegCount} recordings of ${outputFiles.length}`)
    }
    tracker.logAndSetNewPoint(`[${uploadId}] uploaded al segments to S3`)

    console.info(`[${uploadId}] Modifying status to INGESTED (${db.status.INGESTED})`)
    await db.updateUploadStatus(uploadId, db.status.INGESTED, null, buildIngestionResult(coreData, outputFiles, upload))
    tracker.logAndSetNewPoint(`[${uploadId}] updated upload status in Mongo`)

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
    // Transient / unexpected failure: re-throw so the consumer nacks the
    // message (nack-no-requeue -> DLQ).
    throw err
  }
}

module.exports = { ingest }
