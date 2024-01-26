const { Consumer } = require('sqs-consumer')
const AWS = require('../../utils/aws')
const { ingest } = require('../rfcx/ingest')
const { parseUploadFromFileName } = require('./misc')
const TimeTracker = require('../../utils/time-tracker')
const db = require('../db/mongo')

const flacLimitSize = 150_000_000
const wavLimitSize = 200_000_000

const consumer = Consumer.create({
  queueUrl: process.env.SQS_INGEST_TRIGGER_QUEUE_URL,
  batchSize: 1, // this is a default value, but set it to 1 just to make sure it won't be changed in future versions of the lib
  handleMessage: async (message) => {
    let tracker = new TimeTracker('IngestConsumer')
    const files = parseIngestSQSMessage(message)
    for (const file of files) {
      const { fileLocalPath, streamId, uploadId } = parseUploadFromFileName(file.key)
      try {
        const fileExtension = file.bucket.name.split('.').pop().toLowerCase()
        if (fileExtension.toLowerCase() === 'flac' && file.size > flacLimitSize) {
          db.updateUploadStatus(uploadId, db.status.FAILED, `This flac file size is exceeding our limit (${flacLimitSize / 1_000_000}MB)`)
        } else if (fileExtension.toLowerCase() === 'wav' && file.size > wavLimitSize) {
          db.updateUploadStatus(uploadId, db.status.FAILED, `This wav file size is exceeding our limit (${wavLimitSize / 1_000_000}MB)`)
        } else {
          await ingest(file.key, fileLocalPath, streamId, uploadId)
        }
      } catch (e) {
        return false
      }
    }
    tracker.log('processed message')
    tracker = null
    return true
  },
  sqs: new AWS.SQS()
})

consumer.on('error', (err) => {
  console.error('Ingest SQS consumer error', err.message)
})

consumer.on('processing_error', (err) => {
  console.error('Ingest SQS consumer processing_error', err.message)
})

consumer.on('timeout_error', (err) => {
  console.error('Ingest SQS consumer timeout_error', err.message)
})

function parseIngestSQSMessage (message) {
  try {
    const body = JSON.parse(message.Body)
    const filesS3Paths = []
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
    })
    return filesS3Paths
  } catch (e) {
    return []
  }
}

module.exports = consumer
