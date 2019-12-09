const { Consumer } = require('sqs-consumer');
const path = require('path');
const AWS = require('../../utils/aws');
const storage = require('../storage/amazon');
const audioService = require('../audio');
const dirUtil = require('../../utils/dir');
const db = require('../db/amazon');
const segmentService = require('../rfcx/segments')

const consumer = Consumer.create({
  queueUrl: process.env.SQS_INGEST_TRIGGER_QUEUE_URL,
  handleMessage: async (message) => {
    let files = parseIngestSQSMessage(message);
    let proms = [];
    files.forEach((file) => {
      const fileLocalPath = `${process.env.CACHE_DIRECTORY}${file.key}`;
      const streamId = path.dirname(file.key);
      const uploadId = path.basename(file.key, path.extname(file.key));
      let prom =
        dirUtil.ensureDirExists(process.env.CACHE_DIRECTORY)
          .then(() => {
            return dirUtil.ensureDirExists(path.join(process.env.CACHE_DIRECTORY, path.dirname(file.key)))
          })
          .then(() => {
            return storage.download(file.key, `${process.env.CACHE_DIRECTORY}${file.key}`)
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
          return audioService.split(file.key);
        });
        proms.push(prom);
    });
    return Promise.all(proms);
  },
  sqs: new AWS.SQS()
});

consumer.on('error', (err) => {
  console.error('Ingest SQS consumer error', err.message);
});

consumer.on('processing_error', (err) => {
  console.error('Ingest SQS consumer processing_error', err.message);
});

consumer.on('timeout_error', (err) => {
  console.error('Ingest SQS consumer timeout_error', err.message);
 });

function parseIngestSQSMessage(message) {
  try {
    let body = JSON.parse(message.Body);
    let filesS3Paths = [];
    body.Records.forEach((record) => {
      if (record.eventName.includes('ObjectCreated:')) {
        filesS3Paths.push({
          bucket: {
            name: record.s3.bucket.name,
            arn: record.s3.bucket.arn
          },
          key: record.s3.object.key,
          size: record.s3.object.size
        })
      }
    });
    return filesS3Paths
  }
  catch (e) {
    return [];
  }
}

module.exports = consumer
