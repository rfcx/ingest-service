// `stopped` is mutated by amqp connection/channel 'close' event handlers, which
// eslint's static loop analysis can't see -> disable the false-positive rule.
/* eslint-disable no-unmodified-loop-condition */
const amqplib = require('amqplib')
const { ingest } = require('../rfcx/ingest')
const { parseUploadFromFileName } = require('./misc')
const TimeTracker = require('../../utils/time-tracker')
const db = require('../db/mongo')
const lanes = require('./lanes')

const { flacLimitSize, wavLimitSize } = require('../../utils/limits')

const url = process.env.RABBITMQ_URL || process.env.AMQP_URL

// ---------------------------------------------------------------------------
// Multi-lane weighted consumer (2026-07-14, rfcx-local).
//
// The upload work is spread across lane queues (services/consumer/lanes.js):
//   express.0..E-1  -> checked FIRST each cycle (small/fast uploads)
//   priority.0..P-1 -> WEIGHTED: serviced W times per standard visit, but
//                      standard is ALWAYS serviced once per cycle, so priority
//                      is faster WITHOUT starving standard (weighted RR, not
//                      strict priority).
//   standard 0..N-1 -> the fair lanes, rotating round-robin.
//   legacy queue    -> rollback / in-flight drain, LAST.
//
// Pull-based (channel.get) rotating scan, mirroring the analysis pm_consume.py
// design: push-subscribe (channel.consume) cannot enforce cross-queue ordering
// or weighting, so we pull-when-ready. prefetch is irrelevant for get(); we
// process one file at a time (unchanged from the previous single-queue prefetch=1).
//
// priority_weight W is a LIVE rfcxctl knob (rfcxctl:ingest:priority_weight,
// default 3): "for every 1 standard chunk served, serve up to W priority chunks".
// Fractional-credit accumulation lets W be non-integer + de-syncs consumers.
// ---------------------------------------------------------------------------

const POLL_IDLE_MS = parseInt(process.env.INGEST_POLL_IDLE_MS || '500', 10)
const PRIORITY_WEIGHT_DEFAULT = parseFloat(process.env.INGEST_PRIORITY_WEIGHT || '3')
// Cap the priority inner-drain per cycle so express stays responsive even under
// a priority flood (never spend unbounded time before re-checking express).
const PRIORITY_MAX_PER_CYCLE = parseInt(process.env.INGEST_PRIORITY_MAX_PER_CYCLE || '8', 10)

// Priority weight W. Env-configurable (INGEST_PRIORITY_WEIGHT, default 3).
// LIVE rfcxctl tuning (rfcxctl:ingest:priority_weight, like the analysis
// express/prefetch knobs) is a documented follow-up: it needs a redis client
// dependency the ingest-service image doesn't currently carry, so for now the
// weight is a static env (restart to change). The weighted-RR mechanism itself
// is fully live; only the knob's live-tunability is deferred.
async function priorityWeight () {
  return PRIORITY_WEIGHT_DEFAULT
}

// Same S3-event payload shape that SQS receives; the router re-publishes the
// identical body onto a lane queue, so parsing is unchanged.
function parseIngestRecords (body) {
  try {
    const filesS3Paths = []
    body.Records.forEach((record) => {
      if (record.eventName && record.eventName.includes('ObjectCreated:')) {
        filesS3Paths.push({
          bucket: { name: record.s3.bucket.name, arn: record.s3.bucket.arn },
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

// Returns true => ack, false => nack-no-requeue (DLX). Unchanged logic.
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
      console.error(`[${uploadId}] Nacking message to DLQ: ${e && e.message}`)
      return false
    }
  }
  tracker.log('processed message')
  tracker = null
  return true
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Process one raw amqp message (get() result) through handleMessage + ack/nack.
async function processMessage (channel, msg) {
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
    if (result === false) { channel.nack(msg, false, false) } else { channel.ack(msg) }
  } catch (e) {
    console.error('Ingest RabbitMQ: handler threw, nacking:', e && e.message)
    channel.nack(msg, false, false)
  }
}

const RECONNECT_BASE_MS = parseInt(process.env.RABBITMQ_RECONNECT_BASE_MS || '2000', 10)
const RECONNECT_MAX_MS = parseInt(process.env.RABBITMQ_RECONNECT_MAX_MS || '30000', 10)

// Establish a connection + channel, verify all lane queues exist (passive), and
// run the weighted rotating scan loop until the connection/channel drops.
async function consumeLoop () {
  const expressLanes = lanes.expressLanes()
  const priorityLanes = lanes.priorityLanes()
  const fairLanes = lanes.fairLanes()
  const legacy = lanes.LEGACY_QUEUE

  const connection = await amqplib.connect(url)
  let stopped = false
  const stop = () => { stopped = true }
  connection.on('error', (err) => console.error('Ingest RabbitMQ connection error', err && err.message))
  connection.on('close', stop)

  const channel = await connection.createChannel()
  channel.on('error', (err) => console.error('Ingest RabbitMQ channel error', err && err.message))
  channel.on('close', stop)

  // Passive verify every lane exists (topology owned by definitions.json).
  for (const q of lanes.allLanes()) {
    await channel.checkQueue(q) // throws PRECONDITION/NOT_FOUND -> caller retries
  }

  console.info(`Ingest RabbitMQ multi-lane consumer up: express=${expressLanes.length} priority=${priorityLanes.length} fair=${fairLanes.length} (+legacy) weight~${PRIORITY_WEIGHT_DEFAULT}`)

  let expressPtr = 0
  let priorityPtr = 0
  let fairPtr = 0
  let priorityCredit = 0

  // get one message from a queue; null if empty. noAck=false so we ack/nack.
  const getFrom = async (q) => {
    const msg = await channel.get(q, { noAck: false })
    return msg || null // amqplib returns false when empty
  }

  while (!stopped) {
    let didWork = false

    // 1) EXPRESS first (rotating over express lanes) — tiny, always checked.
    for (let i = 0; i < expressLanes.length && !stopped; i++) {
      const q = expressLanes[expressPtr]
      expressPtr = (expressPtr + 1) % expressLanes.length
      const msg = await getFrom(q)
      if (msg) { await processMessage(channel, msg); didWork = true; break }
    }
    if (stopped) { break }
    if (didWork) { continue } // re-check express before anything else

    // 2) PRIORITY — WEIGHTED. Accrue W credits/cycle; serve up to floor(credit)
    //    priority messages (capped), rotating over priority lanes. Standard
    //    (step 3) is ALWAYS served once below regardless -> no starvation.
    const W = await priorityWeight()
    priorityCredit += W
    let served = 0
    while (priorityCredit >= 1 && served < PRIORITY_MAX_PER_CYCLE && !stopped) {
      let got = false
      for (let i = 0; i < priorityLanes.length; i++) {
        const q = priorityLanes[priorityPtr]
        priorityPtr = (priorityPtr + 1) % priorityLanes.length
        const msg = await getFrom(q)
        if (msg) { await processMessage(channel, msg); priorityCredit -= 1; served += 1; got = true; didWork = true; break }
      }
      if (!got) { break } // priority empty; drop leftover credit at cycle end
    }
    // Leftover credits do NOT bank across cycles (no future starvation).
    if (priorityCredit > W) { priorityCredit = W }
    if (stopped) { break }

    // 3) STANDARD — exactly ONE fair-lane message per cycle (rotating). This is
    //    the starvation floor: standard always advances even under a priority
    //    flood.
    for (let i = 0; i < fairLanes.length && !stopped; i++) {
      const q = fairLanes[fairPtr]
      fairPtr = (fairPtr + 1) % fairLanes.length
      const msg = await getFrom(q)
      if (msg) { await processMessage(channel, msg); didWork = true; break }
    }
    if (stopped) { break }

    // 4) LEGACY drain (rollback / in-flight), only when nothing else had work.
    if (!didWork) {
      const msg = await getFrom(legacy)
      if (msg) { await processMessage(channel, msg); didWork = true }
    }

    if (!didWork) { await sleep(POLL_IDLE_MS) } // idle: back off politely
  }

  try { await channel.close() } catch (_) {}
  try { await connection.close() } catch (_) {}
  throw new Error('consume loop ended (connection/channel closed)')
}

// Retry consumeLoop() with capped linear backoff. Neither an initial connect
// failure nor a later drop leaves the pod running-but-not-consuming.
async function connectWithRetry () {
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await consumeLoop()
    } catch (e) {
      attempt += 1
      const delay = Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS)
      console.error(`Ingest RabbitMQ loop attempt ${attempt} ended (${e && e.message}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
}

async function start () {
  if (!url) {
    throw new Error('RABBITMQ_URL (or AMQP_URL) env var must be set when INGEST_CONSUMER_TYPE=rabbitmq')
  }
  await connectWithRetry()
}

module.exports = { start, handleMessage }
