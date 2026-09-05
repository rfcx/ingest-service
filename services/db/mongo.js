const UploadModel = require('./models/mongoose/upload').Upload
const DeploymentInfoModel = require('./models/mongoose/deploymentInfo').DeploymentInfo
const HealthCheckModel = require('./models/mongoose/healthcheck').HealthCheck
const { EmptyResultError } = require('@rfcx/http-utils')
const moment = require('moment-timezone')
const { CastError } = require('mongoose')
const uploadTargets = require('../uploads/upload-targets')

const status = { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30, DUPLICATE: 31, CHECKSUM: 32 }
const statusNumbers = Object.values(status)

function generateUpload (opts) {
  const { streamId, userId, timestamp, originalFilename, fileExtension, sampleRate, targetBitrate, checksum, projectId, duration, uploadTarget, laneTier } = opts

  const upload = new UploadModel({
    streamId,
    userId,
    status: status.WAITING,
    timestamp,
    projectId,
    duration,
    originalFilename,
    sampleRate,
    targetBitrate,
    checksum,
    // rfcx-local lane tier: express|priority|standard, default standard.
    laneTier: ['express', 'priority', 'standard'].includes((laneTier || '').toLowerCase())
      ? laneTier.toLowerCase()
      : 'standard'
  })

  const id = upload._id
  const path = `${streamId}/${id}.${fileExtension}`
  if (uploadTarget) {
    upload.uploadSource = uploadTargets.sourceForKey(uploadTarget, path)
  }

  return upload.save()
    .then((data) => {
      if (data && data._id) {
        return {
          id,
          path,
          uploadSource: data.uploadSource,
          signingSource: uploadTarget ? uploadTargets.sourceForSigning(uploadTarget, path) : undefined
        }
      } else {
        throw Error('Can not create upload.')
      }
    })
}

function getPendingProjectDuration (projectId) {
  if (!projectId) { return Promise.resolve(0) }

  return UploadModel.aggregate([
    {
      $match: {
        projectId,
        status: { $in: [status.WAITING, status.UPLOADED] },
        duration: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: null,
        totalDuration: { $sum: '$duration' }
      }
    }
  ]).then(results => results[0]?.totalDuration ?? 0)
}

function getUpload (id) {
  return UploadModel
    .findById(id)
    .catch((err) => {
      if (err instanceof CastError) {
        throw new EmptyResultError('Upload with given id not found.')
      }
      throw err
    })
}

function setUploadMultipart (uploadId, multipart) {
  return UploadModel.updateOne({ _id: uploadId }, { $set: { multipart, updatedAt: new Date() } })
}

function setUploadMultipartCompleted (uploadId) {
  return UploadModel.updateOne({ _id: uploadId }, { $set: { 'multipart.completedAt': new Date(), updatedAt: new Date() } })
}

function setUploadMultipartAborted (uploadId) {
  return UploadModel.updateOne({ _id: uploadId }, { $set: { 'multipart.abortedAt': new Date(), updatedAt: new Date() } })
}

function updateUploadStatus (uploadId, statusNumber, failureMessage = null, ingestionResult = null) {
  if (!statusNumbers.includes(statusNumber)) {
    throw new Error('Invalid status')
  }
  return getUpload(uploadId)
    .then((upload) => {
      if (!upload) {
        throw new Error('Upload does not exist')
      }
      // TERMINAL-SUCCESS GUARD (2026-08-24) -- parity with uploads-pg.js. An
      // upload that reached INGESTED(20) is never moved to a failure status,
      // so a concurrent duplicate ingest cannot relabel successfully-stored
      // audio as failed. See the full rationale in uploads-pg.js.
      //
      // NOTE this backend is get-then-save, so the guard here is inherently
      // weaker than the PG one (which is atomic in SQL): two writers can still
      // interleave between the read and the save. That is a pre-existing
      // property of this implementation, not a regression -- and this backend
      // is FROZEN in rfcx-local (UPLOADS_DB=pg; the mongo StatefulSet is 0/0).
      // It is implemented anyway so the two backends cannot silently diverge.
      if (upload.status === status.INGESTED &&
          [status.FAILED, status.DUPLICATE, status.CHECKSUM].includes(statusNumber)) {
        console.warn(`[${uploadId}] refusing to overwrite INGESTED(${status.INGESTED}) with ${statusNumber}` +
          (failureMessage ? ` ("${failureMessage}")` : '') +
          ' -- audio already ingested by a concurrent worker')
        return upload
      }
      upload.status = statusNumber
      upload.updatedAt = moment().tz('UTC').toDate()
      if (failureMessage != null) {
        upload.failureMessage = failureMessage
      } else if ([status.UPLOADED, status.INGESTED].includes(statusNumber)) {
        upload.failureMessage = undefined
      }
      if (ingestionResult) {
        upload.ingestionResult = ingestionResult
      }
      return upload.save()
    })
}

function getUploadDuplicateCount () {
  return UploadModel.count({
    status: status.DUPLICATE
  })
}

function getUploadFailedCount () {
  return UploadModel.count({
    status: status.FAILED
  })
}

function getDeploymentInfo (deploymentId) {
  return DeploymentInfoModel.findOne({ deploymentId: deploymentId }).then((result) => {
    if (!result) {
      throw new Error('DeploymentInfo does not exist')
    } else {
      return result
    }
  })
}

function saveDeploymentInfo (opts) {
  const { deploymentId, locationName, latitude, longitude, deployedAt, groupName, groupColor } = opts

  const deploymentInfo = new DeploymentInfoModel({
    deploymentId: deploymentId,
    locationName: locationName,
    latitude: latitude,
    longitude: longitude,
    locationGroup: { groupName, groupColor },
    deployedAt: deployedAt
  })

  return deploymentInfo.save()
    .then((data) => {
      if (data && data._id) {
        return data
      } else {
        throw Error('Can not create DeploymentInfo.')
      }
    })
}

function updateDeploymentInfo (opts) {
  const { deploymentId, locationName, latitude, longitude, deployedAt, groupName, groupColor } = opts

  return getDeploymentInfo(deploymentId)
    .then((deploymentInfo) => {
      if (!deploymentInfo) {
        throw new Error('DeploymentInfo does not exist')
      }

      deploymentInfo.locationName = locationName
      deploymentInfo.latitude = latitude
      deploymentInfo.longitude = longitude
      deploymentInfo.deployedAt = deployedAt
      deploymentInfo.locationGroup = { groupName, groupColor }

      return deploymentInfo.save()
    })
}

// Read-only twin of uploads-pg.js getOrCreateHealthCheck (2026-09-05): the
// readiness probe must not write on EITHER backend, or a UPLOADS_DB=mongo
// rollback would silently change readiness semantics. Returns a stand-in when
// the singleton has never been created; the successful round-trip is the
// signal.
function getOrCreateHealthCheck () {
  return HealthCheckModel.findOne({ event: 'check' }).lean()
    .then(doc => doc || { event: 'check', updated_at: null })
}

// ---------------------------------------------------------------------------
// upload-source cleanup seam (mongo2pg S1)
//
// `upload-source-cleanup.js` previously reached for UploadModel directly. It
// now goes through these two functions, which exist with identical signatures
// and semantics in `uploads-pg.js`, so the cleanup job works on either engine.
// The predicate authorises deletion of real R2/S3 objects — keep the two
// implementations in step.
// ---------------------------------------------------------------------------

/**
 * @param {{ statuses: number[], cutoff: Date, batchSize: number }} opts
 */
function findCleanupCandidates ({ statuses, cutoff, batchSize }) {
  return UploadModel.find({
    status: { $in: statuses },
    updatedAt: { $lte: cutoff },
    uploadSourceDeletedAt: { $exists: false },
    streamId: { $ne: null },
    checksum: { $ne: null },
    originalFilename: { $ne: null }
  })
    .sort({ updatedAt: 1 })
    .limit(batchSize)
}

/**
 * Mongo twin of the PG `findStuckUploads`. Kept in lockstep with it: same
 * predicates, same ordering, same limit semantics, so the reaper behaves
 * identically under either backend (see UPLOADS_DB).
 *
 * NOTE the deliberate absence of an `uploadSourceDeletedAt` filter -- unlike
 * findCleanupCandidates, a stranded upload must be visible whether or not its
 * source object has already been reaped.
 *
 * @param {{ statuses: number[], updatedBefore: Date, limit: number }} opts
 */
function findStuckUploads ({ statuses, updatedBefore, limit }) {
  return UploadModel.find({
    status: { $in: statuses },
    updatedAt: { $lte: updatedBefore },
    streamId: { $ne: null },
    checksum: { $ne: null }
  })
    .sort({ updatedAt: 1 })
    .limit(limit)
}

/**
 * Idempotent: the `$exists:false` guard stops a concurrent second pass from
 * overwriting the original deletion record.
 */
function markUploadSourceDeleted (uploadId, message) {
  return UploadModel.updateOne(
    { _id: uploadId, uploadSourceDeletedAt: { $exists: false } },
    { $set: { uploadSourceDeletedAt: new Date(), uploadSourceCleanupMessage: message } }
  )
}

module.exports = {
  generateUpload,
  getPendingProjectDuration,
  setUploadMultipart,
  setUploadMultipartCompleted,
  setUploadMultipartAborted,
  getUpload,
  getUploadDuplicateCount,
  getUploadFailedCount,
  getDeploymentInfo,
  updateUploadStatus,
  saveDeploymentInfo,
  updateDeploymentInfo,
  getOrCreateHealthCheck,
  findCleanupCandidates,
  findStuckUploads,
  markUploadSourceDeleted,
  status
}
