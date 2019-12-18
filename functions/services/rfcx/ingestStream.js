const platform = process.env.PLATFORM || 'google';

const storage = require(`../storage/${platform}`);
const db = require(`../db/${platform}`);
const audioService = require('../audio');
const dirUtil = require('../../utils/dir');
const segmentService = require('../rfcx/segments')
const path = require('path');
const moment = require('moment');
const uuid = require('uuid/v4');
const ingestManual = require('./legacy/ingestManual');

// Parameters set is different compared to legacy ingest methods

async function ingest (storageFilePath, fileLocalPath, streamId, uploadId) {

  let stream;
  let upload;
  const fileDurationMs = 120000;
  const streamLocalPath = path.join(process.env.CACHE_DIRECTORY, path.dirname(storageFilePath));

  return dirUtil.ensureDirExists(process.env.CACHE_DIRECTORY)
    .then(() => {
      return dirUtil.ensureDirExists(streamLocalPath)
    })
    .then(() => {
      return storage.download(storageFilePath, `${process.env.CACHE_DIRECTORY}${storageFilePath}`)
    })
    .then(() => {
      return db.updateUploadStatus(uploadId, db.status.UPLOADED)
    })
    .then(async () => {
      let fileData = await audioService.identify(fileLocalPath);
      upload = await db.getUpload(uploadId);
      stream = await db.getStream(streamId);
      console.log('\n\nstream', stream, '\n\n')
      console.log('\n\nupload', upload, '\n\n')
      let opts = fileData;
      opts.guid = uploadId;
      opts.idToken = stream.idToken;
      opts.filename = upload.originalFilename;
      return segmentService.createMasterSegment(opts);
    })
    .then(() => {
      console.log('\n\nmaster segment is created in db\n\n');
      return audioService.split(fileLocalPath, path.dirname(fileLocalPath), fileDurationMs/1000);
    })
    .then((outputFiles) => {
      console.log('\n\nfile is splitted', outputFiles, '\n\n');
      let proms = []
      const ts = moment(upload.timestamp);
      outputFiles.forEach((file) => {
        file.guid = uuid();
        let remotePath = `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${upload.streamId}/${file.guid}${path.extname(file.path)}`;
        proms.push(storage.upload(remotePath, file.path));
      })
      return Promise.all(proms)
        .then(() => {
          return outputFiles;
        });
    })
    .then((outputFiles) => {
      console.log('\n\nsegments are uploaded\n\n');
      let proms = []
      const timestamp = moment(upload.timestamp).valueOf();
      let totalDurationMs = 0
      outputFiles.forEach((file) => {
        const duration = Math.round(file.meta.duration * 1000);
        const segmentOpts = {
          guid: file.guid,
          stream: upload.streamId,
          idToken: stream.idToken,
          masterSegment: uploadId,
          starts: timestamp + totalDurationMs,
          ends: timestamp + totalDurationMs + Math.round(file.meta.duration * 1000),
          sample_count: file.meta.sampleCount,
        };
        totalDurationMs += duration;
        console.log('\ncreate segment', segmentOpts, '\n');
        let prom = segmentService.createSegment(segmentOpts)
        proms.push(prom);
      })
      return Promise.all(proms)
        .then(() => {
          return outputFiles;
        });
    })
    .then(async (outputFiles) => { // temporary step which emulated guardian files. to be deleted once we migrate to streams
      console.log('\n\nsegments are saved in db\n\n')
      let totalDurationMs = 0
      // we send files not in parallel, but one after another so API will have time to create GuardianAudioFormat
      // which is same for these files. If we run uploads in parallel, then we will have duplicate rows in GuardianAudioFormats table
      for (let i = 0; i < outputFiles.length; i++) {
        let file = outputFiles[i];
        const duration = Math.round(file.meta.duration * 1000);
        const timestamp = moment(upload.timestamp).add(totalDurationMs, 'milliseconds').toISOString();
        await ingestManual.ingest(file.path, path.basename(file.path), timestamp, upload.streamId, stream.token, stream.idToken)
        totalDurationMs += duration;
      }
      return true
    })
    .then(() => {
      console.log('\n\nguardian audio is saved in db\n\n')
      return db.updateUploadStatus(uploadId, db.status.INGESTED)
    })
    .then(() => {
      console.log('\n\nupload status is changed\n\n')
      return storage.deleteObject(storageFilePath);
    })
    .then(() => {
      console.log('\n\ndeleted original file', storageFilePath, '\n\n');
      return dirUtil.removeDirRecursively(streamLocalPath)
    })
    .then(() => {
      console.log('\n\nremoved stream directory', streamLocalPath, '\n\n');
      stream = null;
      uploadId = null;
    })
    .catch((err) => {
      console.log('\n\ncatch error', err, '\n\n');
      let message = `${err.message}`;
      if (message === 'Duplicate file. Matching sha1 signature already ingested.') {
        // db.updateUploadStatus(uploadId, db.status.DUPLICATE, message); TODO: deploy this line for Ingest App 1.0.5
        db.updateUploadStatus(uploadId, db.status.FAILED, message);
      }
      else {
        message = 'Server failed with processing your file. Please try again later.';
        db.updateUploadStatus(uploadId, db.status.FAILED, message);
      }
      dirUtil.removeDirRecursively(streamLocalPath);
    });

}

module.exports = { ingest }
