const { Consumer } = require('sqs-consumer');
const AWS = require('../../utils/aws');
const { ingest } = require('../rfcx/ingestStream');
const { parseUploadFromFileName } = require('./misc');

const consumer = Consumer.create({
  queueUrl: process.env.SQS_INGEST_TRIGGER_QUEUE_URL,
  batchSize: 1, // this is a default value, but set it to 1 just to make sure it won't be changed in future versions of the lib
  handleMessage: async (message) => {
    let files = parseIngestSQSMessage(message);
    for (let file of files) {
      const { fileLocalPath, streamId, uploadId } = parseUploadFromFileName(file.key);
      await ingest(file.key, fileLocalPath, streamId, uploadId);
    }
    return true;
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
