const platform = process.env.PLATFORM || 'google';

const storage = require(`../storage/${platform}`);
const db = require(`../db/${platform}`);
const audioService = require('../audio');
const dirUtil = require('../../utils/dir');
const segmentService = require('../rfcx/segments')
const path = require('path');

// Parameters set is different compared to legacy ingest methods

async function ingest (storageFilePath, fileLocalPath, streamId, uploadId) {

  return dirUtil.ensureDirExists(process.env.CACHE_DIRECTORY)
    .then(() => {
      return dirUtil.ensureDirExists(path.join(process.env.CACHE_DIRECTORY, path.dirname(storageFilePath)))
    })
    .then(() => {
      return storage.download(storageFilePath, `${process.env.CACHE_DIRECTORY}${storageFilePath}`)
    })
    .then(() => {
      return db.updateUploadStatus(uploadId, db.status.UPLOADED)
    })
    .then(async () => {
      let fileMeta = await audioService.identify(fileLocalPath);
      let upload = await db.getUpload(uploadId);
      let stream = await db.getStream(streamId);
      let opts = fileMeta;
      opts.guid = uploadId;
      opts.idToken = stream.idToken;
      opts.filename = upload.originalFilename;
      return segmentService.createMasterSegment(opts);
    })
    .then(() => {
      return audioService.split(storageFilePath);
    });


}

module.exports = { ingest }
