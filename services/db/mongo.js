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
  const { streamId, userId, timestamp, originalFilename, fileExtension, sampleRate, targetBitrate, checksum, projectId, duration, uploadTarget } = opts

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
    checksum
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
          uploadSource: data.uploadSource
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

function updateUploadStatus (uploadId, statusNumber, failureMessage = null) {
  if (!statusNumbers.includes(statusNumber)) {
    throw new Error('Invalid status')
  }
  return getUpload(uploadId)
    .then((upload) => {
      if (!upload) {
        throw new Error('Upload does not exist')
      }
      upload.status = statusNumber
      upload.updatedAt = moment().tz('UTC').toDate()
      if (failureMessage != null) {
        upload.failureMessage = failureMessage
      } else if ([status.UPLOADED, status.INGESTED].includes(statusNumber)) {
        upload.failureMessage = undefined
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

function getOrCreateHealthCheck () {
  return HealthCheckModel.findOneAndUpdate(
    { event: 'check' },
    { event: 'check' },
    {
      new: true,
      upsert: true
    })
}

module.exports = {
  generateUpload,
  getPendingProjectDuration,
  getUpload,
  getUploadDuplicateCount,
  getUploadFailedCount,
  getDeploymentInfo,
  updateUploadStatus,
  saveDeploymentInfo,
  updateDeploymentInfo,
  getOrCreateHealthCheck,
  status
}
