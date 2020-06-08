const db = require('../../utils/mongo');
const UploadModel = require('./models/mongoose/upload').Upload;
const StreamModel = require('./models/mongoose/stream').Stream;
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
      upload.status = statusNumber;
      upload.updatedAt = moment().tz('UTC').toDate();
      if (failureMessage != null) {
        upload.failureMessage = failureMessage;
      }
      return upload.save();
    })
}

// The following functions for Streams are not used for ingestStream script at the current time. They are here just for consistency with `google` approach.

function createStream (name) {
  const token = '1234' // TODO: this is only here for legacy calls to checkin api
  const streamGuid = hash.randomString(12);
  let stream = new StreamModel({
    guid: streamGuid,
    token,
    name
  })

  return stream.save()
    .then(() => {
      return { id: streamGuid, token };
    });
}

function getStream (guid) {
  return StreamModel.find({ guid });
}

function editStream (guid, name, site) {
  return getStream(guid)
    .then((stream) => {
      stream.name = name
      if (site !== undefined) {
        stream.site = site
      }
      return stream.save();
    })
}

function deleteStream (guid) {
  return StreamModel.deleteOne({ guid });
}


module.exports = {
  generateUpload,
  getUpload,
  updateUploadStatus,
  status,
  createStream,
  getStream,
  editStream,
  deleteStream,
}
