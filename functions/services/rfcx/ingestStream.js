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
const sha1File = require('sha1-file');

const supportedExtensions = ['.wav', '.flac', '.opus'];
const losslessExtensions = ['.wav', '.flac'];
const extensionsRequiringAdditionalData = ['.opus'];

const { IngestionError } = require('../../utils/errors');

// Parameters set is different compared to legacy ingest methods

async function ingest (storageFilePath, fileLocalPath, streamId, uploadId) {

  let stream;
  let upload;
  const fileDurationMs = 120000;
  const streamLocalPath = path.join(process.env.CACHE_DIRECTORY, path.dirname(storageFilePath));

  const fileExtension = path.extname(storageFilePath).toLowerCase();
  const requiresConvToWav = fileExtension === '.flac';
  const isLosslessFile = losslessExtensions.includes(fileExtension);
  const fileLocalPathWav = requiresConvToWav? fileLocalPath.replace(path.extname(fileLocalPath), '.wav') : null;

  let transactionData = {
    masterSegmentGuid: null,
    segmentsGuids: [],
    segmentsFileUrls: []
  }

  return dirUtil.ensureDirExists(process.env.CACHE_DIRECTORY)
    .then(() => {
      if (!supportedExtensions.includes(fileExtension)) {
        throw new IngestionError('File extension is not supported', db.status.FAILED)
      }
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
      console.log('Upload data', upload)
      let opts = fileData;
      console.log('Ffprobe result', fileData)
      opts.guid = uploadId;
      const token = await auth0Service.getToken();
      opts.stream = upload.streamId,
      opts.idToken = `${token.access_token}`;
      opts.filename = upload.originalFilename;
      opts.sha1_checksum = sha1File(fileLocalPath);
      if (isNaN(opts.duration) || opts.duration === 0) {
        throw new IngestionError('Audio duration is zero');
      }
      if (isNaN(opts.sampleCount) || opts.sampleCount === 0) {
        throw new IngestionError('Audio sampleCount is zero' );
      }
      if (extensionsRequiringAdditionalData.includes(fileExtension)) {
        if (!upload.sampleRate) {
          throw new IngestionError(`"sampleRate" must be provided for "${fileExtension}" file ingestion.`);
        }
        if (!upload.targetBitrate) {
          throw new IngestionError(`"targetBitrate" must be provided for ${fileExtension} file ingestion.`);
        }
      }
      if (requiresConvToWav) {
        opts.bitRate = filedataWav.bitRate;
        opts.duration = filedataWav.duration;
      }
      // if sampleRate and bitRate were specified on upload request, then set them implicitly
      if (upload.sampleRate) opts.sampleRate = upload.sampleRate;
      if (upload.targetBitrate) opts.bitRate = upload.targetBitrate;

      return segmentService.createMasterSegment(opts)
        .then(() => {
          transactionData.masterSegmentGuid = opts.guid;
        })
        .catch((err) => {
          if (err.response && err.response.data && err.response.data.message) {
            let message = err.response.data.message;
            let status = message === 'Duplicate file. Matching sha1 signature already ingested.'? db.status.DUPLICATE : db.status.FAILED;
            throw new IngestionError(message, status)
          } else {
            throw err
          }
        });
    })
    .then(() => {
      console.log('Master segment is created in db');
      return audioService.split(requiresConvToWav? fileLocalPathWav : fileLocalPath, path.dirname(fileLocalPath), fileDurationMs/1000);
    })
    .then(async (outputFiles) => {
      console.log('File is splitted', outputFiles);
      // convert lossless files to flac format
      if (isLosslessFile) {
        for (let file of outputFiles) {
          let finalPath = file.path.replace(path.extname(file.path), '.flac');
          await audioService.convert(file.path, finalPath);
          file.path = finalPath;
        }
      }

      let totalDurationMs = 0
      for (let file of outputFiles) {
        const duration = Math.floor(file.meta.duration * 1000);
        const ts = moment.tz(upload.timestamp, 'UTC').add(totalDurationMs, 'milliseconds');
        file.guid = uuid();
        let remotePath = `${ts.format('YYYY')}/${ts.format('MM')}/${ts.format('DD')}/${upload.streamId}/${file.guid}${path.extname(file.path)}`;
        totalDurationMs += duration;
        transactionData.segmentsFileUrls.push(remotePath);
        await storage.upload(remotePath, file.path);
        console.log('Segment', file.path, 'has been uploaded to', remotePath);
      }
      return outputFiles;
    })
    .then(async (outputFiles) => {
      console.log('Segments are uploaded');
      const timestamp = moment.tz(upload.timestamp, 'UTC').valueOf();
      let totalDurationMs = 0
      const token = await auth0Service.getToken();
      for (let file of outputFiles) {
        const duration = Math.floor(file.meta.duration * 1000);
        const segmentOpts = {
          guid: file.guid,
          stream: upload.streamId,
          idToken: `${token.access_token}`,
          masterSegment: uploadId,
          starts: timestamp + totalDurationMs,
          ends: timestamp + totalDurationMs + duration,
          sample_count: file.meta.sampleCount,
          file_extension: path.extname(file.path),
        };
        totalDurationMs += duration;
        await segmentService.createSegment(segmentOpts)
        console.log('Segment', segmentOpts, 'has been saved in DB');
        transactionData.segmentsGuids.push(segmentOpts.guid);
      }
      return outputFiles;
    })
    .then(() => {
      console.log('Segments are saved in db')
      return db.updateUploadStatus(uploadId, db.status.INGESTED)
    })
    .then(() => {
      console.log(`Upload status is changed to INGESTED (${db.status.INGESTED})`)
      return storage.deleteObject(storageFilePath);
    })
    .then(() => {
      console.log('Deleted original file', storageFilePath);
      return dirUtil.removeDirRecursively(streamLocalPath)
    })
    .then(() => {
      console.log('Removed stream directory', streamLocalPath);
      stream = null;
      uploadId = null;
    })
    .catch(async (err) => {
      console.error(`Error thrown for upload ${uploadId}`, err);
      let message = err instanceof IngestionError? err.message : 'Server failed with processing your file. Please try again later.';
      let status = err instanceof IngestionError? err.status : db.status.FAILED;
      db.updateUploadStatus(uploadId, status, message);
      for (let filePath of transactionData.segmentsFileUrls) {
        await storage.deleteObject(filePath);
      }
      for (let guid of transactionData.segmentsGuids) {
        await segmentService.deleteSegment({ guid });
      }
      if (transactionData.masterSegmentGuid) {
        await segmentService.deleteMasterSegment({ guid: transactionData.masterSegmentGuid });
      }
      await storage.deleteObject(storageFilePath);
      dirUtil.removeDirRecursively(streamLocalPath);
    });

}

module.exports = { ingest }
