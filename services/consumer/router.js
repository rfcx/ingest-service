'use strict'
// Ingest lane ROUTER (2026-07-14, rfcx-local).
//
// Consumes the LEGACY queue (ingest-service-upload-production, fed unchanged by
// rfcx-api after the R2->CF->api chain), looks up the upload's laneTier from
// Mongo (keyed by the uploadId embedded in the S3 object key), and RE-PUBLISHES
// the identical S3-event body onto the matching lane queue. The weighted
// multi-lane consumer (rabbitmq.js) then drains the lanes.
//
// Why a router (not publish-from-rfcx-api): keeps ALL lane logic in
// ingest-service; rfcx-api / the R2->api producer path is untouched.
//
// Safe to run in EVERY tasks pod: RabbitMQ delivers each legacy message to
// exactly one consumer, so N routers just share the load (no duplication).
// Re-publish is idempotent enough (a message lands on exactly one lane; if the
// router crashes after publish-before-ack, the legacy message redelivers and
// the file is re-published to a lane -> the consumer's ingest() is itself
// duplicate-safe, same as before).

// `stopped` is mutated by amqp connection/channel 'close' event handlers, which
// eslint's static loop analysis can't see -> disable the false-positive rule.
/* eslint-disable no-unmodified-loop-condition */
const amqplib = require('amqplib')
const db = require('../db/mongo')
const lanes = require('./lanes')
const { parseUploadFromFileName } = require('./misc')

const url = process.env.RABBITMQ_URL || process.env.AMQP_URL
const LEGACY = lanes.LEGACY_QUEUE
const ROUTER_ENABLED = (process.env.INGEST_LANE_ROUTER || 'on').toLowerCase() !== 'off'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RECONNECT_BASE_MS = parseInt(process.env.RABBITMQ_RECONNECT_BASE_MS || '2000', 10)
const RECONNECT_MAX_MS = parseInt(process.env.RABBITMQ_RECONNECT_MAX_MS || '30000', 10)

// Extract the uploadId from the FIRST ObjectCreated record's key, so we can
// look up its laneTier. All records in one message share a laneTier in practice
// (one upload per event); we route the whole message by the first.
function firstUploadId (body) {
  try {
    for (const record of body.Records || []) {
      if (record.eventName && record.eventName.includes('ObjectCreated:')) {
        const { uploadId } = parseUploadFromFileName(record.s3.object.key)
        return uploadId
      }
    }
  } catch (_) {}
  return null
}

async function laneTierForBody (body) {
  const uploadId = firstUploadId(body)
  if (!uploadId) { return 'standard' }
  try {
    const upload = await db.getUpload(uploadId)
    return lanes.normaliseTier(upload && upload.laneTier)
  } catch (_) {
    // Upload not found / DB blip -> fail safe to standard (never drop).
    return 'standard'
  }
}

async function routerLoop () {
  const connection = await amqplib.connect(url)
  let stopped = false
  const stop = () => { stopped = true }
  connection.on('error', (e) => console.error('Ingest router connection error', e && e.message))
  connection.on('close', stop)

  // Confirm channel: sendToQueue + waitForConfirms needs a CONFIRM channel
  // (amqplib exposes waitForConfirms only on createConfirmChannel(); a plain
  // channel has no confirmSelect()).
  const channel = await connection.createConfirmChannel()
  channel.on('error', (e) => console.error('Ingest router channel error', e && e.message))
  channel.on('close', stop)

  // passive-verify the legacy input + confirm at least the fair lanes exist
  await channel.checkQueue(LEGACY)
  for (const q of [...lanes.expressLanes(), ...lanes.priorityLanes(), ...lanes.fairLanes()]) {
    await channel.checkQueue(q)
  }
  // (confirm channel already established above -> waitForConfirms works)
  await channel.prefetch(20) // small pipeline; routing is cheap

  // depth cache for least-loaded lane selection (refreshed opportunistically).
  const depthCache = new Map()
  const depthOf = (q) => (depthCache.has(q) ? depthCache.get(q) : 0)
  const refreshDepths = async (tier) => {
    for (const q of lanes.lanesForTier(tier)) {
      try { const ok = await channel.checkQueue(q); depthCache.set(q, ok.messageCount) } catch (_) {}
    }
  }

  console.info(`Ingest lane router up: legacy="${LEGACY}" -> express/priority/fair lanes`)

  await channel.consume(LEGACY, async (msg) => {
    if (msg === null) { return }
    let body
    try {
      body = JSON.parse(msg.content.toString('utf8'))
    } catch (e) {
      console.error('Ingest router: bad JSON on legacy queue, nacking:', e && e.message)
      channel.nack(msg, false, false)
      return
    }
    try {
      const tier = await laneTierForBody(body)
      await refreshDepths(tier)
      const target = lanes.pickLane(tier, depthOf)
      // Re-publish the identical body to the target lane (default exchange,
      // routing_key = queue name). Persistent, wait for confirm.
      channel.sendToQueue(target, msg.content, { persistent: true, contentType: 'application/json' })
      await channel.waitForConfirms()
      // bump local depth so a burst of same-tier messages spreads across lanes
      depthCache.set(target, depthOf(target) + 1)
      channel.ack(msg)
    } catch (e) {
      // publish/confirm failed -> nack-requeue so the legacy message is retried
      // (transient broker issue); do NOT DLX (nothing wrong with the message).
      console.error('Ingest router: publish failed, requeueing:', e && e.message)
      try { channel.nack(msg, false, true) } catch (_) {}
    }
  })

  // idle wait until the connection drops
  while (!stopped) { await sleep(1000) }
  try { await channel.close() } catch (_) {}
  try { await connection.close() } catch (_) {}
  throw new Error('router loop ended (connection/channel closed)')
}

async function startRouter () {
  if (!ROUTER_ENABLED) { console.info('Ingest lane router disabled (INGEST_LANE_ROUTER=off)'); return }
  if (!url) { throw new Error('RABBITMQ_URL/AMQP_URL required for the ingest lane router') }
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await routerLoop()
    } catch (e) {
      attempt += 1
      const delay = Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS)
      console.error(`Ingest router loop attempt ${attempt} ended (${e && e.message}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
}

module.exports = { startRouter, laneTierForBody, firstUploadId }
