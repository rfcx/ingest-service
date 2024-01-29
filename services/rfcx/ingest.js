const platform = process.env.PLATFORM || 'amazon'

const storage = require(`../storage/${platform}`)
const db = require('../db/mongo')
const audioService = require('../audio')
const dirUtil = require('../../utils/dir')
const segmentService = require('../rfcx/segments')
const { chunks } = require('../../utils/array')
const { PROMETHEUS_ENABLED, registerHistogram, pushHistogramMetric } = require('../../services/prometheus')
const path = require('path')
const moment = require('moment-timezone')
const TimeTracker = require('../../utils/time-tracker')
const uploadBucket = process.env.UPLOAD_BUCKET
const ingestBucket = process.env.INGEST_BUCKET
const errorBucket = process.env.ERROR_BUCKET

const supportedExtensions = ['.wav', '.flac', '.opus']
const losslessExtensions = ['.wav', '.flac']
const extensionsRequiringConvToWav = ['.flac']

const { IngestionError } = require('../../utils/errors')
const loggerIgnoredErrors = [
  'Duplicate file. Matching sha1 signature already ingested.',
  'This file was already ingested.',
  'File extension is not supported',
  'Stream source file was not created'
]

if (PROMETHEUS_ENABLED) {
  // create historgram for each available file format
  supportedExtensions.forEach((ext) => {
    const name = ext.substr(1)
    registerHistogram(name, `Processing metric for ${name} format.`)
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
  if (meta.duration > (60 * 60 * 1)) {
    throw new IngestionError('Audio duration is more than 1 hour')
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
  return outputFiles.map((file) => {
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

async function ingest (fileStoragePath, fileLocalPath, streamId, uploadId) {
  let tracker = new TimeTracker('IngestTask')
  let outputFiles
  let coreData
  const streamLocalPath = getStreamLocalPath(fileStoragePath)
  try {
    const startTimestamp = Date.now() // is used for processing time calculation
    const fileExtension = path.extname(fileStoragePath).toLowerCase()

    validateFileFormat(fileExtension)
    await createStreamLocalPath(streamLocalPath)
    console.info(`[${uploadId}] Downloading file from storage`)
    tracker.setPoint()
    await storage.download(fileStoragePath, getFileLocalPath(fileStoragePath))
    tracker.logAndSetNewPoint('downloaded file')
    console.info(`[${uploadId}] Updating upload status to UPLOADED`)
    await db.updateUploadStatus(uploadId, db.status.UPLOADED)
    tracker.logAndSetNewPoint('updated upload status in Mongo')

    const fileData = await audioService.identify(fileLocalPath)
    tracker.logAndSetNewPoint('identified file with ffmpeg')
    console.info(`[${uploadId}] Audio metadata`, JSON.stringify(fileData))
    const upload = await db.getUpload(uploadId)
    console.info(`[${uploadId}] Upload metadata from database `, JSON.stringify(upload))
    validateAudioMeta(upload, fileData, fileExtension)

    console.info(`[${uploadId}] Transcoding file`)
    tracker.setPoint()
    const transcodeData = await transcode(fileLocalPath, fileData)
    tracker.logAndSetNewPoint('transcoded file')
    outputFiles = transcodeData.outputFiles
    setAdditionalFileAttrs(outputFiles, upload)

    console.info(`[${uploadId}] Saving data in the Core API`)
    const corePayload = combineCorePayloadData(fileData, transcodeData.wavMeta, outputFiles, upload)
    tracker.setPoint()
    coreData = await segmentService.createStreamFileData(upload.streamId, corePayload)
    tracker.logAndSetNewPoint('created data in Core API')

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
    tracker.logAndSetNewPoint('uploaded al segments to S3')

    console.info(`[${uploadId}] Modifying status to INGESTED (${db.status.INGESTED})`)
    await db.updateUploadStatus(uploadId, db.status.INGESTED)
    tracker.logAndSetNewPoint('updated upload status in Mongo')

    uploadId = null
    if (PROMETHEUS_ENABLED && fileData.sampleCount) {
      console.info(`[${uploadId}] Updating processing metrics`)
      const processingValue = (Date.now() - startTimestamp) / fileData.sampleCount * 10000 // we use multiplier because values are far less than 1 in other case
      pushHistogramMetric(fileExtension.substr(1), processingValue)
      tracker.logAndSetNewPoint('pushed histogram metric')
    }
    console.info(`[${uploadId}] Cleaning up files`)
    await storage.deleteObject(uploadBucket, fileStoragePath)
    await dirUtil.removeDirRecursively(streamLocalPath)
    tracker.logAndSetNewPoint('cleaned up files')
    tracker = null
  } catch (err) {
    /**
     * ERROR HANDLING
     */
    if (loggerIgnoredErrors.includes(err.message)) {
      console.warn(`[${uploadId}] Warn for upload ${uploadId} ${err.message}`)
    } else {
      console.error(`[${uploadId}] Error for upload ${uploadId} ${err.message}`)
    }
    const message = err instanceof IngestionError ? err.message : 'Server failed with processing your file. Please try again later.'
    const status = err instanceof IngestionError ? err.status : db.status.FAILED
    await db.updateUploadStatus(uploadId, status, message)
    for (const file of outputFiles) {
      try {
        await storage.deleteObject(ingestBucket, file.remotePath)
      } catch (e) {
        console.info(`[${uploadId}] Rollback: failed deleting file ${file.remotePath}`)
      }
    }
    if (coreData) {
      try {
        await segmentService.deleteStreamSourceFile(streamId, coreData)
      } catch (e) {
        console.info(`[${uploadId}] Rollback: failed deleting stream source file ${coreData.streamSourceFile.id}`, e)
      }
    }

    if (!loggerIgnoredErrors.includes(message)) {
      await storage.copy(`${uploadBucket}/${fileStoragePath}`, errorBucket, fileStoragePath)
      // create error log text file in the same bucket
      const storageErrorFilePath = fileStoragePath.replace(path.extname(fileStoragePath), '.txt')
      await storage.createFromData(errorBucket, storageErrorFilePath, `message: ${err.message}\n\nstack: ${err.stack}`)
    }

    await storage.deleteObject(uploadBucket, fileStoragePath)
    await dirUtil.removeDirRecursively(streamLocalPath)
  }
}

module.exports = { ingest }
