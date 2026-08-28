'use strict'
// Ingest lane topology + routing (2026-07-14, rfcx-local).
//
// Mirrors the analysis-tier lane design (pm_queue_lib.py) for the ingest tier.
// A "router" stage consumes the legacy ingest-service-upload-production queue,
// reads the upload's laneTier from Mongo, and re-publishes each S3-event to the
// matching lane queue; the weighted multi-lane consumer then drains the lanes.
//
// Lane tiers (laneTier on the Mongo StreamUpload doc, default "standard"):
//   express   -> ingest.work.express.0..E-1   (small/fast uploads jump ahead)
//   priority  -> ingest.work.priority.0..P-1  (paid/priority; WEIGHTED, not
//                                               strict -> standard never starves)
//   standard  -> ingest.work.0..N-1           (the fair lanes, round-robin)
// Legacy ingest-service-upload-production is kept as the ROUTER's input queue
// (rfcx-api still publishes there, untouched) + a rollback drain.
//
// All queue topology (quorum, DLX, delivery-limit) is declared in
// rfcx-local platform/rabbitmq/definitions.json and applied at bootstrap; here
// we only NAME the queues + do passive checkQueue (never assertQueue).

const LANE_COUNT = parseInt(process.env.INGEST_LANE_COUNT || '10', 10)
const EXPRESS_COUNT = parseInt(process.env.INGEST_EXPRESS_COUNT || '2', 10)
const PRIORITY_COUNT = parseInt(process.env.INGEST_PRIORITY_COUNT || '2', 10)
// Background lanes (2026-08-27). Deferred/bulk work that must never compete
// with live uploads: served ONLY when every higher tier is idle (see the
// step-5 pass in rabbitmq.js). Queues are declared in rfcx-local
// platform/rabbitmq/definitions.json, which also carries the TTL exemption --
// without that exemption a background backlog would silently expire at 24h.
const BACKGROUND_COUNT = parseInt(process.env.INGEST_BACKGROUND_COUNT || '2', 10)

// Base name for the lane family. The router's INPUT is the legacy queue.
const LANE_BASE = process.env.INGEST_LANE_BASE || 'ingest.work'
const LEGACY_QUEUE = process.env.RABBITMQ_INGEST_TRIGGER_QUEUE || 'ingest-service-upload-production'

// Order here is descending service priority; `standard` stays the DEFAULT for
// any unknown/absent value (see normaliseTier) so a typo can never demote work
// into background.
const TIERS = ['express', 'priority', 'standard', 'background']

function fairLane (i) { return `${LANE_BASE}.${i}` }
function expressLane (i) { return `${LANE_BASE}.express.${i}` }
function priorityLane (i) { return `${LANE_BASE}.priority.${i}` }
function backgroundLane (i) { return `${LANE_BASE}.background.${i}` }

function fairLanes () { return Array.from({ length: LANE_COUNT }, (_, i) => fairLane(i)) }
function expressLanes () { return Array.from({ length: EXPRESS_COUNT }, (_, i) => expressLane(i)) }
function priorityLanes () { return Array.from({ length: PRIORITY_COUNT }, (_, i) => priorityLane(i)) }
function backgroundLanes () { return Array.from({ length: BACKGROUND_COUNT }, (_, i) => backgroundLane(i)) }

// Normalise a laneTier value -> canonical tier. Unknown/empty -> "standard".
function normaliseTier (tier) {
  const t = (tier || '').toString().trim().toLowerCase()
  return TIERS.includes(t) ? t : 'standard'
}

// The list of lanes for a tier (used by the router to pick a target lane).
function lanesForTier (tier) {
  switch (normaliseTier(tier)) {
    case 'express': return expressLanes()
    case 'priority': return priorityLanes()
    case 'background': return backgroundLanes()
    default: return fairLanes()
  }
}

// All lanes the CONSUMER drains, in NO particular order (ordering/weighting is
// the consumer's scan loop, not this list). Includes the legacy queue LAST as a
// rollback/in-flight drain.
function allLanes () {
  return [...expressLanes(), ...priorityLanes(), ...fairLanes(),
    ...backgroundLanes(), LEGACY_QUEUE]
}

// Pick a target lane for a message of `tier`, given current lane depths, using
// least-loaded + random tie-break (mirrors least_loaded_fair_queue: keeps two
// simultaneous messages off the same lane instead of always stacking lane 0).
// `depthOf(lane) -> integer` is provided by the caller (from checkQueue).
function pickLane (tier, depthOf) {
  const lanes = lanesForTier(tier)
  if (lanes.length === 0) { return fairLane(0) }
  let lo = Infinity
  for (const l of lanes) { const d = depthOf(l); if (d < lo) { lo = d } }
  const mins = lanes.filter((l) => depthOf(l) === lo)
  return mins[Math.floor(Math.random() * mins.length)]
}

module.exports = {
  LANE_COUNT,
  EXPRESS_COUNT,
  PRIORITY_COUNT,
  BACKGROUND_COUNT,
  LANE_BASE,
  LEGACY_QUEUE,
  TIERS,
  fairLane,
  expressLane,
  priorityLane,
  backgroundLane,
  fairLanes,
  expressLanes,
  priorityLanes,
  backgroundLanes,
  normaliseTier,
  lanesForTier,
  allLanes,
  pickLane
}
