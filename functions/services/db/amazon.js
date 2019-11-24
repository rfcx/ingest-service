const db = require('../../utils/redis');
const moment = require('moment-timezone');
const uuid = require('uuid/v4');

const status = { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30 }
const statusNumbers = Object.values(status)

function generateUpload (streamId, userId, timestamp, originalFilename, fileType) {
  const now = moment().tz('UTC').valueOf();
  const uploadId = uuid();
  const path = `uploaded/${streamId}/${uploadId}.${fileType}`;
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

function getKeyJSONValue(key) {
  return db.getAsync(key)
    .then((data) => {
      return JSON.parse(data);
    });
}

function getUpload (id) {
  return getKeyJSONValue(`upload-${id}`);
}

function updateUploadStatus (id, statusNumber, failureMessage = null) {
  if (!statusNumbers.includes(statusNumber)) {
    return Promise.reject('Invalid status')
  }
  return getUpload(id)
    .then((dataStr) => {
      let data = JSON.parse(dataStr);
      data.status = statusNumber;
      data.updatedAt = moment().tz('UTC').valueOf();
      if (failureMessage != null) {
        data.failureMessage = failureMessage;
      }
      return db.setAsync(id, JSON.stringify(data));
    })
}

function createStream (name) {
  const token = '1234' // TODO: this is only here for legacy calls to checkin api
  const streamGuid = uuid();
  return db.setAsync(`stream-${streamGuid}`, JSON.stringify({ name, token }))
    .then((data) => {
      console.log('createStream redis data', data);
      return {
        id: streamGuid,
        token
      };
    });
}

function getStream (id) {
  return getKeyJSONValue(`stream-${id}`);
}

module.exports = { generateUpload, getUpload, updateUploadStatus, status, createStream, getStream }
