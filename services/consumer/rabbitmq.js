const { MessageQueue } = require('@rfcx/message-queue')
const { ingest } = require('../rfcx/ingest')
const { parseUploadFromFileName } = require('./misc')
const TimeTracker = require('../../utils/time-tracker')
const db = require('../db/mongo')

const flacLimitSize = 150_000_000
const wavLimitSize = 200_000_000

const queueName = process.env.RABBITMQ_INGEST_TRIGGER_QUEUE || 'ingest-service-upload-production'

const mq = new MessageQueue('rabbitmq')

// Same S3-event payload shape that SQS receives from AWS S3 event notifications;
// this lets the s3-cache publisher and AWS S3 both feed compatible bodies.
//   { Records: [ { eventName: "ObjectCreated:Put",
//                  s3: { bucket: { name, arn }, object: { key, size } } } ] }
function parseIngestRecords (body) {
  try {
    const filesS3Paths = []
    body.Records.forEach((record) => {
      if (record.eventName && record.eventName.includes('ObjectCreated:')) {
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

async function handleMessage (body) {
  let tracker = new TimeTracker('IngestConsumer')
  const files = parseIngestRecords(body)
  for (const file of files) {
    const { fileLocalPath, streamId, uploadId } = parseUploadFromFileName(file.key)
    try {
      const fileExtension = file.key.split('.').pop().toLowerCase()
      if (fileExtension === 'flac' && file.size > flacLimitSize) {
        db.updateUploadStatus(uploadId, db.status.FAILED, `This flac file size is exceeding our limit (${flacLimitSize / 1_000_000}MB)`)
      } else if (fileExtension === 'wav' && file.size > wavLimitSize) {
        db.updateUploadStatus(uploadId, db.status.FAILED, `This wav file size is exceeding our limit (${wavLimitSize / 1_000_000}MB)`)
      } else {
        await ingest(file.key, fileLocalPath, streamId, uploadId)
      }
    } catch (e) {
      // returning false nacks the message; @rfcx/message-queue rabbitmq
      // adapter routes nack-no-requeue → DLX, matching SQS-without-redrive
      // semantics.
      return false
    }
  }
  tracker.log('processed message')
  tracker = null
  return true
}

function start () {
  mq.subscribe(queueName, handleMessage)
  console.info(`Ingest RabbitMQ consumer subscribed to queue "${queueName}"`)
}

module.exports = { start }
