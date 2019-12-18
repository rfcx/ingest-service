const db = require('../../utils/redis');
const moment = require('moment-timezone');
const uuid = require('uuid/v4');

const status = { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30, DUPLICATE: 31 }
const statusNumbers = Object.values(status)

function generateUpload (streamId, userId, timestamp, originalFilename, fileType) {
  const now = moment().tz('UTC').valueOf();
  const uploadId = uuid();
  const path = `${streamId}/${uploadId}.${fileType}`;
  const opts = {
    streamId,
    userId,
    status: status.WAITING,
    createdAt: now,
    updatedAt: now,
    timestamp,
    originalFilename,
    path
  };
  return db.setAsync(`upload-${uploadId}`, JSON.stringify(opts))
    .then((data) => {
      console.log('generateUpload redis data', data);
      return {
        id: uploadId,
        path
      };
    });
}

function getKeyJSONValue (key) {
  return db.getAsync(key)
    .then((data) => {
      return JSON.parse(data);
    });
}

function getUpload (id) {
  return getKeyJSONValue(`upload-${id}`);
}

function updateUploadStatus (uploadId, statusNumber, failureMessage = null) {
  if (!statusNumbers.includes(statusNumber)) {
    return Promise.reject('Invalid status')
  }
  return getUpload(uploadId)
    .then((data) => {
      data.status = statusNumber;
      data.updatedAt = moment().tz('UTC').valueOf();
      if (failureMessage != null) {
        data.failureMessage = failureMessage;
      }
      return db.setAsync(`upload-${uploadId}`, JSON.stringify(data));
    })
}

function createStream (name, idToken) {
  const token = '1234' // TODO: this is only here for legacy calls to checkin api
  const streamGuid = uuid();
  return db.setAsync(`stream-${streamGuid}`, JSON.stringify({ name, token, idToken }))
    .then((data) => {
      console.log('createStream redis data', data);
      return {
        id: streamGuid,
        token,
        idToken
      };
    });
}

function getStream (id) {
  return getKeyJSONValue(`stream-${id}`)
}

function editStream (id, name, site) { // TODO needs testing
  return getKeyJSONValue(`stream-${id}`).then(stream => {
    stream.name = name
    if (site !== undefined) {
      stream.site = site
    }
    return db.setAsync(`stream-${id}`, JSON.stringify(stream))
      .then((data) => {
        console.log('editStream redis data', data)
      })
  })
}

module.exports = { generateUpload, getUpload, updateUploadStatus, status, createStream, getStream, editStream }
