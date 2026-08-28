// `stopped` is mutated by amqp connection/channel 'close' event handlers, which
// eslint's static loop analysis can't see -> disable the false-positive rule.
/* eslint-disable no-unmodified-loop-condition */
const amqplib = require('amqplib')
const { ingest } = require('../rfcx/ingest')
const { parseUploadFromFileName } = require('./misc')
const TimeTracker = require('../../utils/time-tracker')
const db = require('../db/uploads')
const lanes = require('./lanes')
// Router liveness, for the legacy-queue single-reader invariant (2026-08-24).
// Safe: router.js does NOT require this module, so there is no import cycle.
const router = require('./router')

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

// ---------------------------------------------------------------------------
// GRACEFUL DRAIN ON SIGTERM/SIGINT (2026-08-27, rfcx-local §242).
//
// Without this, a pod deletion (KEDA scale-down, rollout) killed the process
// mid-ingest: the in-flight message requeued fine, but its redelivery was then
// claim-skipped + ACKED against the dead worker's still-fresh ingest claim
// (claim TTL 30 min >> redelivery seconds), so the upload wedged at status 10
// until the 3h stuck-upload reaper marked it FAILED. Measured 2026-08-27:
// 13 wedged rows in one 45-min scale flap.
//
// With this, SIGTERM flips termRequested: every pickup loop stands down (no
// NEW work), the in-flight file finishes and is acked normally, and the
// process exits 0. Files that genuinely outlast the grace period keep the old
// behavior (SIGKILL -> requeue -> claim-skip -> reaper) — bounded and rare.
// ---------------------------------------------------------------------------
let termRequested = false
function requestTerm (sig) {
  if (termRequested) { return }
  termRequested = true
  console.info(`Ingest RabbitMQ: ${sig} received — draining in-flight ingest, no new pickups`)
}
process.once('SIGTERM', () => requestTerm('SIGTERM'))
process.once('SIGINT', () => requestTerm('SIGINT'))
// Test hook: lets a unit test request a drain without sending real signals.
function _setTermRequestedForTest (v) { termRequested = v }
function isTermRequested () { return termRequested }
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
  const backgroundLanes = lanes.backgroundLanes()
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

  console.info(`Ingest RabbitMQ multi-lane consumer up: express=${expressLanes.length} priority=${priorityLanes.length} fair=${fairLanes.length} background=${backgroundLanes.length} (+legacy) weight~${PRIORITY_WEIGHT_DEFAULT}`)

  let expressPtr = 0
  let priorityPtr = 0
  let fairPtr = 0
  let backgroundPtr = 0
  let priorityCredit = 0

  // get one message from a queue; null if empty. noAck=false so we ack/nack.
  const getFrom = async (q) => {
    const msg = await channel.get(q, { noAck: false })
    return msg || null // amqplib returns false when empty
  }

  while (!stopped && !termRequested) {
    let didWork = false

    // 1) EXPRESS first (rotating over express lanes) — tiny, always checked.
    for (let i = 0; i < expressLanes.length && !stopped && !termRequested; i++) {
      const q = expressLanes[expressPtr]
      expressPtr = (expressPtr + 1) % expressLanes.length
      const msg = await getFrom(q)
      if (msg) { await processMessage(channel, msg); didWork = true; break }
    }
    if (stopped || termRequested) { break }
    if (didWork) { continue } // re-check express before anything else

    // 2) PRIORITY — WEIGHTED. Accrue W credits/cycle; serve up to floor(credit)
    //    priority messages (capped), rotating over priority lanes. Standard
    //    (step 3) is ALWAYS served once below regardless -> no starvation.
    const W = await priorityWeight()
    priorityCredit += W
    let served = 0
    while (priorityCredit >= 1 && served < PRIORITY_MAX_PER_CYCLE && !stopped && !termRequested) {
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
    if (stopped || termRequested) { break }

    // 3) STANDARD — exactly ONE fair-lane message per cycle (rotating). This is
    //    the starvation floor: standard always advances even under a priority
    //    flood.
    for (let i = 0; i < fairLanes.length && !stopped && !termRequested; i++) {
      const q = fairLanes[fairPtr]
      fairPtr = (fairPtr + 1) % fairLanes.length
      const msg = await getFrom(q)
      if (msg) { await processMessage(channel, msg); didWork = true; break }
    }
    if (stopped || termRequested) { break }

    // 4) BACKGROUND — deferred/bulk work, served ONLY when every higher tier
    //    was idle this cycle (same `!didWork` idiom as the legacy drain below).
    //
    //    WHY NOT A CREDIT LIKE PRIORITY: standard (step 3) is already fixed at
    //    exactly ONE message per cycle, so a background credit of 1 would make
    //    background EQUAL to standard -- not a background tier at all. The
    //    analysis ladder's "background = 1" means the DENOMINATOR baseline
    //    (serviced least, work-conserving, never starving the tiers above);
    //    in this loop that is precisely the !didWork gate.
    //
    //    Work-conserving: when the higher tiers are empty this runs every
    //    cycle at full speed, so a background backlog still drains promptly on
    //    an otherwise-idle fleet.
    if (!didWork) {
      for (let i = 0; i < backgroundLanes.length && !stopped && !termRequested; i++) {
        const q = backgroundLanes[backgroundPtr]
        backgroundPtr = (backgroundPtr + 1) % backgroundLanes.length
        const msg = await getFrom(q)
        if (msg) { await processMessage(channel, msg); didWork = true; break }
      }
    }
    if (stopped || termRequested) { break }

    // 5) LEGACY drain (rollback / in-flight), only when nothing else had work
    //    AND this pod's router is not already reading that queue.
    //
    //    The router (channel.consume, push) and this drain (get, poll) are BOTH
    //    readers of the legacy queue in EVERY tasks pod. "Only when nothing else
    //    had work" guards LOCAL state, not global: on an idle fleet this poll
    //    can win a message before the router routes it, and the same upload is
    //    then ingested twice concurrently (measured 2026-08-24: 568 of 715
    //    upload ids touched by >1 pod). Standing down while the router is live
    //    makes the legacy queue single-reader per pod.
    //
    //    Deliberately gated on router LIVE STATE, not on INGEST_LANE_ROUTER:
    //    main-tasks.js lets the router fail without killing the pod precisely
    //    because this drain covers it, so an env gate would leave the queue with
    //    zero readers here after a router crash. See the invariant block in
    //    services/consumer/router.js.
    if (!didWork && !router.isConsumingLegacy()) {
      const msg = await getFrom(legacy)
      if (msg) { await processMessage(channel, msg); didWork = true }
    }

    if (!didWork) { await sleep(POLL_IDLE_MS) } // idle: back off politely
  }

  try { await channel.close() } catch (_) {}
  try { await connection.close() } catch (_) {}
  if (termRequested) {
    console.info('Ingest RabbitMQ: drain complete — in-flight work finished, no new pickups')
    return 'drained'
  }
  throw new Error('consume loop ended (connection/channel closed)')
}

// Retry consumeLoop() with capped linear backoff. Neither an initial connect
// failure nor a later drop leaves the pod running-but-not-consuming.
async function connectWithRetry () {
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res
    try {
      res = await consumeLoop()
    } catch (e) {
      attempt += 1
      const delay = Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS)
      console.error(`Ingest RabbitMQ loop attempt ${attempt} ended (${e && e.message}); retrying in ${delay}ms`)
      await sleep(delay)
      continue
    }
    if (res === 'drained') {
      // SIGTERM drain: the in-flight ingest finished + was acked; exit 0 so
      // kubernetes records a clean termination, not a crash. Deliberately
      // OUTSIDE the try: a drain must never fall into the reconnect path.
      console.info('Ingest RabbitMQ: drained on SIGTERM; exiting')
      process.exit(0)
    }
  }
}

async function start () {
  if (!url) {
    throw new Error('RABBITMQ_URL (or AMQP_URL) env var must be set when INGEST_CONSUMER_TYPE=rabbitmq')
  }
  await connectWithRetry()
}

module.exports = { start, handleMessage, _setTermRequestedForTest, isTermRequested, _internal: { consumeLoop, connectWithRetry } }
