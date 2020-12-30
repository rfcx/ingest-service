const platform = process.env.PLATFORM || 'google'

const storage = require(`../storage/${platform}`)
const db = require('../db/mongo')
const audioService = require('../audio')
const dirUtil = require('../../utils/dir')
const segmentService = require('../rfcx/segments')
const auth0Service = require('../../services/auth0')
const arbimonService = require('../../services/arbimon')
const { PROMETHEUS_ENABLED, registerHistogram, pushHistogramMetric } = require('../../services/prometheus')
const path = require('path')
const moment = require('moment-timezone')
const uuid = require('uuid/v4')
const sha1File = require('sha1-file')
const uploadBucket = process.env.UPLOAD_BUCKET
const ingestBucket = process.env.INGEST_BUCKET

const supportedExtensions = ['.wav', '.flac', '.opus']
const losslessExtensions = ['.wav', '.flac']
const extensionsRequiringAdditionalData = ['.opus']

const { IngestionError } = require('../../utils/errors')

if (PROMETHEUS_ENABLED) {
  // create historgram for each available file format
  supportedExtensions.forEach((ext) => {
    const name = ext.substr(1)
    registerHistogram(name, `Processing metric for ${name} format.`)
  })
}


// Parameters set is different compared to legacy ingest methods

async function ingest (storageFilePath, fileLocalPath, streamId, uploadId) {
  let upload
  const startTimestamp = Date.now()
  const fileDurationMs = 120000
  const streamLocalPath = path.join(process.env.CACHE_DIRECTORY, path.dirname(storageFilePath))

  const fileExtension = path.extname(storageFilePath).toLowerCase()
  const requiresConvToWav = fileExtension === '.flac'
  const isLosslessFile = losslessExtensions.includes(fileExtension)
  const fileLocalPathWav = requiresConvToWav ? fileLocalPath.replace(path.extname(fileLocalPath), '.wav') : null

  const transactionData = {
    streamSourceFileId: null,
    segmentsGuids: [],
    segmentsFileUrls: []
  }
  let fileSampleCount
  let fileFormat = fileExtension.substr(1)

  return dirUtil.ensureDirExists(process.env.CACHE_DIRECTORY)
    .then(() => {
      if (!supportedExtensions.includes(fileExtension)) {
        throw new IngestionError('File extension is not supported', db.status.FAILED)
      }
      return dirUtil.ensureDirExists(streamLocalPath)
    })
    .then(() => {
      return storage.download(storageFilePath, `${process.env.CACHE_DIRECTORY}${storageFilePath}`)
    })
    .then(() => {
      return db.updateUploadStatus(uploadId, db.status.UPLOADED)
    })
    .then(async () => {
      let filedataWav
      if (requiresConvToWav) {
        const convRes = await audioService.convert(fileLocalPath, fileLocalPathWav)
        filedataWav = convRes.meta
      }
      const fileData = await audioService.identify(fileLocalPath)
      upload = await db.getUpload(uploadId)
      console.log('Upload meta from client', JSON.stringify(upload))
      const opts = fileData
      console.log('Ffprobe result', JSON.stringify(fileData))
      fileSampleCount = opts.sampleCount || undefined
      const token = await auth0Service.getToken()
      opts.stream = upload.streamId
      opts.idToken = `${token.access_token}`
      opts.filename = upload.originalFilename
      opts.sha1_checksum = sha1File(fileLocalPath)
      if (isNaN(opts.duration) || opts.duration === 0) {
        throw new IngestionError('Audio duration is zero')
      }
      if (isNaN(opts.sampleCount) || opts.sampleCount === 0) {
        throw new IngestionError('Audio sampleCount is zero')
      }
      if (extensionsRequiringAdditionalData.includes(fileExtension)) {
        if (!upload.sampleRate) {
          throw new IngestionError(`"sampleRate" must be provided for "${fileExtension}" file ingestion.`)
        }
        if (!upload.targetBitrate) {
          throw new IngestionError(`"targetBitrate" must be provided for ${fileExtension} file ingestion.`)
        }
      }
      if (upload.checksum && upload.checksum !== opts.sha1_checksum) {
        throw new IngestionError('Checksum mismatch.', db.status.CHECKSUM)
      }
      if (requiresConvToWav) {
        opts.bitRate = filedataWav.bitRate
        opts.duration = filedataWav.duration
      }
      // if sampleRate and bitRate were specified on upload request, then set them implicitly
      if (upload.sampleRate) opts.sampleRate = upload.sampleRate
      if (upload.targetBitrate) opts.bitRate = upload.targetBitrate

      console.log(`Creating original file in the API (stream ${opts.stream} sha1_checksum ${opts.sha1_checksum}`)
      return segmentService.createStreamSourceFile(opts)
        .then((response) => {
          if (!response || response.status !== 201) {
            throw new Error('Stream source file was not created')
          }
          transactionData.streamSourceFileId = response.data.id
        })
        .catch((err) => {
          if (err.response && err.response.data && err.response.data.message) {
            const message = err.response.data.message
            let status
            switch (message) {
              case 'Duplicate file. Matching sha1 signature already ingested.':
                status = db.status.DUPLICATE
                break
              case 'This file was already ingested.':
                status = db.status.INGESTED
                break
              default:
                status = db.status.FAILED
            }
            throw new IngestionError(message, status)
          } else {
            throw err
          }
        })
    })
    .then(() => {
      console.log('Splitting original file into segments')
      return audioService.split(requiresConvToWav ? fileLocalPathWav : fileLocalPath, path.dirname(fileLocalPath), fileDurationMs / 1000)
    })
    .then(async (outputFiles) => {
      console.log(`File was split into ${outputFiles.length} segments`)
      // convert lossless files to flac format
      if (isLosslessFile) {
        for (const file of outputFiles) {
          const finalPath = file.path.replace(path.extname(file.path), '.flac')
          await audioService.convert(file.path, finalPath)
          file.path = finalPath
        }
      }

      let totalDurationMs = 0
      for (const file of outputFiles) {
        const duration = Math.floor(file.meta.duration * 1000)
        const ts = moment.tz(upload.timestamp, 'UTC').add(totalDurationMs, 'milliseconds')
        file.guid = uuid()
        file.remotePath = `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${upload.streamId}/${file.guid}${path.extname(file.path)}`
        totalDurationMs += duration
        transactionData.segmentsFileUrls.push(file.remotePath)
        console.log(`Uploading segment ${file.path} to ${file.remotePath}`)
        await storage.upload(file.remotePath, file.path)
      }
      return outputFiles
    })
    .then(async (outputFiles) => {
      const timestamp = moment.tz(upload.timestamp, 'UTC').valueOf()
      let totalDurationMs = 0
      const token = await auth0Service.getToken()
      for (const file of outputFiles) {
        const duration = Math.floor(file.meta.duration * 1000)
        file.start = moment.tz(timestamp + totalDurationMs, 'UTC').toISOString()
        file.end = moment.tz(timestamp + totalDurationMs + duration, 'UTC').toISOString()
        const segmentOpts = {
          id: file.guid,
          stream: upload.streamId,
          idToken: `${token.access_token}`,
          streamSourceFileId: transactionData.streamSourceFileId,
          start: file.start,
          end: file.end,
          sample_count: file.meta.sampleCount,
          file_extension: path.extname(file.path)
        }
        totalDurationMs += duration
        console.log(`Creating segment ${segmentOpts.id} in the API`)
        await segmentService.createSegment(segmentOpts)
        transactionData.segmentsGuids.push(segmentOpts.id)
      }
      return outputFiles
    })
    .then(async (outputFiles) => {
      console.log(`Modifying status to INGESTED (${db.status.INGESTED})`)
      await db.updateUploadStatus(uploadId, db.status.INGESTED)
      return outputFiles
    })
    .then(async (outputFiles) => {
      if (`${process.env.ARBIMON_ENABLED}` === 'true') {
        let totalDurationMs = 0
        for (const file of outputFiles) {
          const duration = file.meta.duration
          const recording = {
            site_external_id: upload.streamId,
            uri: file.remotePath,
            datetime: file.start,
            sample_rate: upload.sampleRate || file.meta.sampleRate,
            precision: 0,
            duration,
            samples: file.meta.sampleCount,
            file_size: file.meta.size,
            bit_rate: upload.targetBitrate || file.meta.bitRate,
            sample_encoding: file.meta.codec
          }
          totalDurationMs += duration
          console.log(`Creating recording ${recording.uri} in the Arbimon`, recording)
          const token = await auth0Service.getToken()
          const idToken = `Bearer ${token.access_token}`
          await arbimonService.createRecording(recording, idToken)
        }
      }
    })
    .then(async () => {
      console.log('Cleaning up files')
      uploadId = null
      if (PROMETHEUS_ENABLED && fileSampleCount) {
        const processingValue = (Date.now() - startTimestamp) / fileSampleCount * 10000 // we use multiplier because values are far less than 1 in other case
        pushHistogramMetric(fileFormat, processingValue)
      }
      await storage.deleteObject(uploadBucket, storageFilePath)
      return dirUtil.removeDirRecursively(streamLocalPath)
    })
    .catch(async (err) => {
      console.error(`Error thrown for upload ${uploadId}`, err.message || '')
      const message = err instanceof IngestionError ? err.message : 'Server failed with processing your file. Please try again later.'
      let status = err instanceof IngestionError ? err.status : db.status.FAILED
      db.updateUploadStatus(uploadId, status, message)
      for (const filePath of transactionData.segmentsFileUrls) {
        await storage.deleteObject(ingestBucket, filePath)
      }
      for (const guid of transactionData.segmentsGuids) {
        await segmentService.deleteSegment({ guid })
      }
      if (transactionData.streamSourceFileId) {
        await segmentService.deleteStreamSourceFile({ guid: transactionData.streamSourceFileId })
      }
      await storage.deleteObject(uploadBucket, storageFilePath)
      dirUtil.removeDirRecursively(streamLocalPath)
    })
}

module.exports = { ingest }
