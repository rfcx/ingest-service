const moment = require('moment-timezone')
const path = require('path')

const UploadModel = require('../db/models/mongoose/upload').Upload
const db = require('../db/mongo')
const segmentService = require('./segments')
const storage = require(`../storage/${process.env.PLATFORM || 'amazon'}`)

function getUploadBucket () {
  return process.env.UPLOAD_BUCKET
}

function parseBool (value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function parseStatuses (value) {
  return String(value || `${db.status.INGESTED},${db.status.DUPLICATE}`)
    .split(',')
    .map(v => parseInt(v.trim(), 10))
    .filter(v => !Number.isNaN(v))
}

function uploadSourceKey (upload) {
  if (upload.uploadSource && upload.uploadSource.key) {
    return upload.uploadSource.key
  }
  const ext = path.extname(upload.originalFilename || '').replace(/^\./, '').toLowerCase()
  if (!ext) {
    return null
  }
  return `${upload.streamId}/${upload._id}.${ext}`
}

function uploadSourceBucket (upload) {
  return upload.uploadSource?.bucket || getUploadBucket()
}

function isNotFoundError (err) {
  return err && (err.statusCode === 404 || err.code === 'NotFound' || err.code === 'NoSuchKey')
}

function buildConfig (env = process.env) {
  return {
    dryRun: parseBool(env.UPLOAD_SOURCE_CLEANUP_DRY_RUN, true),
    ageHours: parseInt(env.UPLOAD_SOURCE_CLEANUP_AGE_HOURS || '24', 10),
    batchSize: parseInt(env.UPLOAD_SOURCE_CLEANUP_BATCH_SIZE || '100', 10),
    statuses: parseStatuses(env.UPLOAD_SOURCE_CLEANUP_STATUSES),
    coreVerify: parseBool(env.UPLOAD_SOURCE_CLEANUP_CORE_VERIFY, true)
  }
}

async function findCandidates (config) {
  const cutoff = moment.utc().subtract(config.ageHours, 'hours').toDate()
  return UploadModel.find({
    status: { $in: config.statuses },
    updatedAt: { $lte: cutoff },
    uploadSourceDeletedAt: { $exists: false },
    streamId: { $ne: null },
    checksum: { $ne: null },
    originalFilename: { $ne: null }
  })
    .sort({ updatedAt: 1 })
    .limit(config.batchSize)
}

async function coreConfirmsIngested (upload) {
  const found = await segmentService.findIngestedDuplicate(
    upload.streamId,
    upload.checksum,
    moment.tz(upload.timestamp, 'UTC')
  )
  return !!(found && found.id)
}

async function markDeleted (upload, message) {
  await UploadModel.updateOne(
    { _id: upload._id, uploadSourceDeletedAt: { $exists: false } },
    { $set: { uploadSourceDeletedAt: new Date(), uploadSourceCleanupMessage: message } }
  )
}

async function cleanupUpload (upload, config) {
  const key = uploadSourceKey(upload)
  if (!key) {
    console.warn(`[upload-source-cleanup] skip upload=${upload._id} reason=missing-extension`)
    return 'skippedMissingExtension'
  }

  if (config.coreVerify) {
    const verified = await coreConfirmsIngested(upload)
    if (!verified) {
      console.warn(`[upload-source-cleanup] skip upload=${upload._id} key=${key} reason=core-not-confirmed`)
      return 'skippedCoreUnconfirmed'
    }
  }

  const bucket = uploadSourceBucket(upload)
  if (!bucket) {
    console.warn(`[upload-source-cleanup] skip upload=${upload._id} key=${key} reason=missing-bucket`)
    return 'skippedMissingBucket'
  }

  if (config.dryRun) {
    console.info(`[upload-source-cleanup] dry-run delete bucket=${bucket} key=${key} upload=${upload._id}`)
    return 'dryRun'
  }

  try {
    await storage.deleteObject(bucket, key)
    await markDeleted(upload, `deleted ${bucket}/${key}`)
    console.info(`[upload-source-cleanup] deleted bucket=${bucket} key=${key} upload=${upload._id}`)
    return 'deleted'
  } catch (err) {
    if (isNotFoundError(err)) {
      await markDeleted(upload, `already missing ${bucket}/${key}`)
      console.info(`[upload-source-cleanup] already-missing bucket=${bucket} key=${key} upload=${upload._id}`)
      return 'alreadyMissing'
    }
    console.error(`[upload-source-cleanup] error upload=${upload._id} bucket=${bucket} key=${key} ${err && err.message}`)
    return 'error'
  }
}

async function runUploadSourceCleanup (config = buildConfig()) {
  const candidates = await findCandidates(config)
  const counts = {
    scanned: candidates.length,
    dryRun: 0,
    deleted: 0,
    alreadyMissing: 0,
    skippedMissingExtension: 0,
    skippedMissingBucket: 0,
    skippedCoreUnconfirmed: 0,
    error: 0
  }

  for (const upload of candidates) {
    const result = await cleanupUpload(upload, config)
    counts[result] = (counts[result] || 0) + 1
  }

  console.info('[upload-source-cleanup] summary', JSON.stringify({
    dryRun: config.dryRun,
    ageHours: config.ageHours,
    batchSize: config.batchSize,
    statuses: config.statuses,
    coreVerify: config.coreVerify,
    uploadBucket: getUploadBucket(),
    counts
  }))
  return counts
}

module.exports = {
  buildConfig,
  uploadSourceKey,
  runUploadSourceCleanup
}
