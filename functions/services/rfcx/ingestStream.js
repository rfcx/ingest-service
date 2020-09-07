const platform = process.env.PLATFORM || 'google'

const storage = require(`../storage/${platform}`)
const db = require('../db/mongo')
const audioService = require('../audio')
const dirUtil = require('../../utils/dir')
const segmentService = require('../rfcx/segments')
const auth0Service = require('../../services/auth0')
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

// Parameters set is different compared to legacy ingest methods

async function ingest (storageFilePath, fileLocalPath, streamId, uploadId) {
  let upload
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
            const status = message === 'Duplicate file. Matching sha1 signature already ingested.' ? db.status.DUPLICATE : db.status.FAILED
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
        const remotePath = `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${upload.streamId}/${file.guid}${path.extname(file.path)}`
        totalDurationMs += duration
        transactionData.segmentsFileUrls.push(remotePath)
        console.log(`Uploading segment ${file.path} to ${remotePath}`)
        await storage.upload(remotePath, file.path)
      }
      return outputFiles
    })
    .then(async (outputFiles) => {
      const timestamp = moment.tz(upload.timestamp, 'UTC').valueOf()
      let totalDurationMs = 0
      const token = await auth0Service.getToken()
      for (const file of outputFiles) {
        const duration = Math.floor(file.meta.duration * 1000)
        const segmentOpts = {
          id: file.guid,
          stream: upload.streamId,
          idToken: `${token.access_token}`,
          streamSourceFileId: transactionData.streamSourceFileId,
          start: moment.tz(timestamp + totalDurationMs, 'UTC').toISOString(),
          end: moment.tz(timestamp + totalDurationMs + duration, 'UTC').toISOString(),
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
    .then(() => {
      console.log(`Modifying status to INGESTED (${db.status.INGESTED})`)
      return db.updateUploadStatus(uploadId, db.status.INGESTED)
    })
    .then(async () => {
      console.log('Cleaning up files')
      uploadId = null
      await storage.deleteObject(uploadBucket, storageFilePath)
      return dirUtil.removeDirRecursively(streamLocalPath)
    })
    .catch(async (err) => {
      console.error(`Error thrown for upload ${uploadId}`, err)
      const message = err instanceof IngestionError ? err.message : 'Server failed with processing your file. Please try again later.'
      const status = err instanceof IngestionError ? err.status : db.status.FAILED
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
