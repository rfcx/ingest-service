const db = require('../../utils/mongo');
const UploadModel = require('./models/mongoose/upload').Upload;
const DeploymentInfoModel = require('./models/mongoose/deploymentInfo').DeploymentInfo;
const moment = require('moment-timezone');
const hash = require('../../utils/hash');

const status = { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30, DUPLICATE: 31, CHECKSUM: 32 }
const statusNumbers = Object.values(status)

function generateUpload (opts) {

  const { streamId, userId, timestamp, originalFilename, fileExtension, sampleRate, targetBitrate, checksum  } = opts;

  let upload = new UploadModel({
    streamId,
    userId,
    status: status.WAITING,
    timestamp,
    originalFilename,
    sampleRate,
    targetBitrate,
    checksum
  });

  return upload.save()
    .then((data) => {
      if (data && data._id) {
        const id = data._id;
        return {
          id,
          path: `${streamId}/${id}.${fileExtension}`
        }
      }
      else {
        throw Error('Can not create upload.');
      }
    });
}

function getUpload (id) {
  return UploadModel.findById(id);
}

function updateUploadStatus (uploadId, statusNumber, failureMessage = null) {
  if (!statusNumbers.includes(statusNumber)) {
    return Promise.reject('Invalid status')
  }
  return getUpload(uploadId)
    .then((upload) => {
      if (!upload) {
        return Promise.reject('Upload does not exist')
      }
      upload.status = statusNumber;
      upload.updatedAt = moment().tz('UTC').toDate();
      if (failureMessage != null) {
        upload.failureMessage = failureMessage;
      }
      return upload.save();
    })
}

function getDeploymentInfo (deploymentId) {
  return DeploymentInfoModel.findById(deploymentId)
}

function saveDeploymentInfo (opts) {
  const {deploymentId, locationName, latitude, longitude, deployedAt} = opts

  let deploymentInfo = new DeploymentInfoModel({
    deploymentId, 
    locationName, 
    latitude, 
    longitude, 
    deployedAt
  })

  return deploymentInfo.save()
    .then((data) => {
      if (data && data._id) {
        return
      }
      else {
        throw Error('Can not create upload.')
      }
    })
}

function updateDeploymentInfo (deploymentId, locationName, latitude, longitude) {
  return getDeploymentInfo(deploymentId)
    .then((deploymentInfo) => {
      if (!deploymentInfo) {
        return Promise.reject('Upload does not exist')
      }

      deploymentId.locationName = locationName
      deploymentId.latitude = latitude
      deploymentId.longitude = longitude

      return deploymentInfo.save;
    })
}

module.exports = {
  generateUpload,
  getUpload,
  updateUploadStatus,
  saveDeploymentInfo,
  status
}
