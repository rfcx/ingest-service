const amqplib = require('amqplib')
const { ingest } = require('../rfcx/ingest')
const { parseUploadFromFileName } = require('./misc')
const TimeTracker = require('../../utils/time-tracker')
const db = require('../db/mongo')

const flacLimitSize = 150_000_000
const wavLimitSize = 200_000_000

const queueName = process.env.RABBITMQ_INGEST_TRIGGER_QUEUE || 'ingest-service-upload-production'
const url = process.env.RABBITMQ_URL || process.env.AMQP_URL

// Same S3-event payload shape that SQS receives from AWS S3 event notifications;
// this lets an s3-cache/s3-writer publisher and AWS S3 both feed compatible bodies.
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
        // ingest() RESOLVES for both success and "handled terminal"
        // outcomes (duplicate / already-ingested / checksum mismatch /
        // unsupported / size) — those are fully recorded against the
        // upload and re-processing will never resolve them, so we ACK-drop
        // them rather than flooding the DLQ. It only THROWS on transient /
        // unexpected failures, which we nack-no-requeue to the DLX below.
        await ingest(file.key, fileLocalPath, streamId, uploadId)
      }
    } catch (e) {
      // returning false nacks the message; nack-no-requeue routes to DLX
      // (matching SQS-without-redrive semantics). Reserved for transient /
      // unexpected failures worth inspecting/redriving.
      console.error(`[${uploadId}] Nacking message to DLQ: ${e && e.message}`)
      return false
    }
  }
  tracker.log('processed message')
  tracker = null
  return true
}

// Direct amqplib consumer.
//
// We do NOT call assertQueue here. The queue topology
// (durable, x-queue-type=quorum, x-dead-letter-exchange=dlx,
// x-dead-letter-routing-key, x-delivery-limit) is owned by
// the rfcx-local platform via platform/rabbitmq/definitions.json
// and applied at cluster bootstrap. Calling assertQueue with
// a different argument set causes PRECONDITION_FAILED.
//
// Instead, we use checkQueue (passive declare): it fails if
// the queue does not exist, but does not conflict with the
// existing arguments. The publisher side has the same rule.
async function start () {
  if (!url) {
    throw new Error('RABBITMQ_URL (or AMQP_URL) env var must be set when INGEST_CONSUMER_TYPE=rabbitmq')
  }
  const connection = await amqplib.connect(url)
  connection.on('error', (err) => {
    console.error('Ingest RabbitMQ connection error', err && err.message)
  })
  connection.on('close', () => {
    console.error('Ingest RabbitMQ connection closed; exiting so kubernetes can restart us')
    process.exit(1)
  })
  const channel = await connection.createChannel()
  channel.on('error', (err) => {
    console.error('Ingest RabbitMQ channel error', err && err.message)
  })
  channel.on('close', () => {
    console.error('Ingest RabbitMQ channel closed; exiting so kubernetes can restart us')
    process.exit(1)
  })
  await channel.checkQueue(queueName) // passive; fails if not pre-declared
  await channel.prefetch(1)
  await channel.consume(queueName, async (msg) => {
    if (msg === null) { return } // consumer cancelled by server
    let body
    try {
      body = JSON.parse(msg.content.toString('utf8'))
    } catch (e) {
      console.error('Ingest RabbitMQ: bad JSON, nacking:', e && e.message)
      channel.nack(msg, false, false)
      return
    }
    try {
      const result = await handleMessage(body)
      if (result === false) {
        channel.nack(msg, false, false)
      } else {
        channel.ack(msg)
      }
    } catch (e) {
      console.error('Ingest RabbitMQ: handler threw, nacking:', e && e.message)
      channel.nack(msg, false, false)
    }
  })
  console.info(`Ingest RabbitMQ consumer subscribed to queue "${queueName}"`)
}

module.exports = { start }
