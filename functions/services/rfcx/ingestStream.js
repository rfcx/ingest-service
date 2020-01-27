const platform = process.env.PLATFORM || 'google';

const storage = require(`../storage/${platform}`);
const db = require(`../db/${platform}`);
const audioService = require('../audio');
const dirUtil = require('../../utils/dir');
const segmentService = require('../rfcx/segments')
const auth0Service = require('../../services/auth0')
const path = require('path');
const moment = require('moment-timezone');
const uuid = require('uuid/v4');
const ingestManual = require('./legacy/ingestManual');
const sha1File = require('sha1-file');

// Parameters set is different compared to legacy ingest methods

async function ingest (storageFilePath, fileLocalPath, streamId, uploadId) {

  let stream;
  let upload;
  const fileDurationMs = 120000;
  const streamLocalPath = path.join(process.env.CACHE_DIRECTORY, path.dirname(storageFilePath));

  const requiresConvToWav = path.extname(fileLocalPath) === '.flac';
  const fileLocalPathWav = requiresConvToWav? fileLocalPath.replace(path.extname(fileLocalPath), '.wav') : null;

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
      let filedataWav;
      if (requiresConvToWav) {
        let convRes = await audioService.convert(fileLocalPath, fileLocalPathWav);
        filedataWav = convRes.meta;
      }
      let fileData = await audioService.identify(fileLocalPath);
      upload = await db.getUpload(uploadId);
      stream = await db.getStream(streamId);
      console.log('\n\nstream', stream, '\n\n')
      console.log('\n\nupload', upload, '\n\n')
      let opts = fileData;
      opts.guid = uploadId;
      const token = await auth0Service.getToken();
      opts.stream = upload.streamId,
      opts.idToken = `${token.access_token}`;
      opts.filename = upload.originalFilename;
      opts.sha1_checksum = sha1File(fileLocalPath);
      if (requiresConvToWav) {
        opts.bitRate = filedataWav.bitRate;
        opts.duration = filedataWav.duration;
      }
      return segmentService.createMasterSegment(opts)
        .catch((err) => {
          if (err.response && err.response.data && err.response.data.message) {
            throw { message: err.response.data.message }
          } else {
            throw err
          }
        });
    })
    .then(() => {
      console.log('\n\nmaster segment is created in db\n\n');
      return audioService.split(requiresConvToWav? fileLocalPathWav : fileLocalPath, path.dirname(fileLocalPath), fileDurationMs/1000);
    })
    .then(async (outputFiles) => {
      console.log('\n\nfile is splitted', outputFiles, '\n\n');
      // convert wav files back to original format
      if (requiresConvToWav) {
        for (let i = 0; i < outputFiles.length; i++) {
          let file = outputFiles[i];
          let finalPath = file.path.replace('.wav', path.extname(fileLocalPath));
          await audioService.convert(file.path, finalPath);
          file.path = finalPath;
        }
      }

      let proms = []
      let totalDurationMs = 0
      outputFiles.forEach((file) => {
        const duration = Math.round(file.meta.duration * 1000);
        const ts = moment.tz(upload.timestamp, 'UTC').add(totalDurationMs, 'milliseconds');
        file.guid = uuid();
        let remotePath = `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${upload.streamId}/${file.guid}${path.extname(file.path)}`;
        totalDurationMs += duration;
        proms.push(storage.upload(remotePath, file.path));
      })
      return Promise.all(proms)
        .then(() => {
          return outputFiles;
        });
    })
    .then(async (outputFiles) => {
      console.log('\n\nsegments are uploaded\n\n');
      let proms = []
      const timestamp = moment.tz(upload.timestamp, 'UTC').valueOf();
      let totalDurationMs = 0
      const token = await auth0Service.getToken();
      outputFiles.forEach((file) => {
        const duration = Math.round(file.meta.duration * 1000);
        const segmentOpts = {
          guid: file.guid,
          stream: upload.streamId,
          idToken: `${token.access_token}`,
          masterSegment: uploadId,
          starts: timestamp + totalDurationMs,
          ends: timestamp + totalDurationMs + Math.round(file.meta.duration * 1000),
          sample_count: file.meta.sampleCount,
          file_extension: path.extname(file.path),
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
      const token = await auth0Service.getToken();
      // we send files not in parallel, but one after another so API will have time to create GuardianAudioFormat
      // which is same for these files. If we run uploads in parallel, then we will have duplicate rows in GuardianAudioFormats table
      for (let i = 0; i < outputFiles.length; i++) {
        let file = outputFiles[i];
        const duration = Math.round(file.meta.duration * 1000);
        const timestamp = moment(upload.timestamp).add(totalDurationMs, 'milliseconds').toISOString();
        await ingestManual.ingest(file.path, path.basename(file.path), timestamp, upload.streamId, stream.token, `${token.access_token}`)
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
        db.updateUploadStatus(uploadId, db.status.DUPLICATE, message);
      }
      else {
        message = 'Server failed with processing your file. Please try again later.';
        db.updateUploadStatus(uploadId, db.status.FAILED, message);
      }
      storage.deleteObject(storageFilePath);
      dirUtil.removeDirRecursively(streamLocalPath);
    });

}

module.exports = { ingest }
