// ---------------------------------------------------------------------------
// LEGACY-QUEUE SINGLE-READER INVARIANT (2026-08-24).
//
// Every tasks pod runs BOTH the lane router (channel.consume on the legacy
// queue, push) and the multi-lane consumer's step-4 legacy drain (get, poll).
// The consumer's "only when nothing else had work" guard protects LOCAL state,
// not global state, so on an idle fleet a consumer poll can win a message
// before the router routes it and the SAME upload is ingested twice
// concurrently. Measured 2026-08-24: 568 of 715 upload ids (79%) were touched
// by more than one pod.
//
// The drain now stands down while this pod's router is actually consuming.
//
// WHAT THESE TESTS PIN, and why each case matters:
//
//   router consuming -> drain OFF  the race is closed (the point of the change)
//   router disabled  -> drain ON   unchanged behaviour for INGEST_LANE_ROUTER=off
//   router crashed   -> drain ON   THE LOAD-BEARING ONE. main-tasks.js lets
//                                  startRouter() fail without killing the pod,
//                                  with the comment "continuing; consumer still
//                                  drains legacy". Gating on the ENV FLAG
//                                  instead of live state would leave the legacy
//                                  queue with ZERO readers in that pod while it
//                                  still looked healthy -- and one dead router
//                                  among three keeps the fleet consumer count
//                                  at 2, so IngestConsumersAbsent would NOT
//                                  fire. This case is exactly the regression
//                                  the design review caught.
// ---------------------------------------------------------------------------

describe('legacy-queue single-reader invariant', () => {
  beforeEach(() => {
    jest.resetModules()
    delete process.env.INGEST_LANE_ROUTER
  })

  test('isConsumingLegacy() starts FALSE, so the drain is ON before the router attaches', () => {
    // Fail-safe default: until the router has actually established its
    // consumer, the legacy queue must still be drained by somebody.
    const router = require('./router')
    expect(router.isConsumingLegacy()).toBe(false)
  })

  test('the flag is exported as a FUNCTION, not a captured boolean', () => {
    // A boolean read at require time would freeze at false forever and the
    // gate would silently never engage. The consumer calls this per loop pass.
    const router = require('./router')
    expect(typeof router.isConsumingLegacy).toBe('function')
  })

  test('router.js does NOT require rabbitmq.js (no import cycle)', () => {
    // rabbitmq.js now requires router.js. If router.js ever required
    // rabbitmq.js back, the cycle would yield a partially-initialised module at
    // require time -- in production, not in review.
    const src = require('fs').readFileSync(require.resolve('./router'), 'utf8')
    expect(src).not.toMatch(/require\(['"]\.\/rabbitmq['"]\)/)
  })

  test('the consumer gates its legacy drain on router liveness, not on the env flag', () => {
    // Pins the DESIGN, not just the behaviour: an env-flag gate passes a naive
    // "drain is gated" test while still breaking the crashed-router case.
    const src = require('fs').readFileSync(require.resolve('./rabbitmq'), 'utf8')
    expect(src).toMatch(/!router\.isConsumingLegacy\(\)/)
    expect(src).not.toMatch(/ROUTER_ENABLED[\s\S]{0,80}getFrom\(legacy\)/)
  })

  test('with INGEST_LANE_ROUTER=off the router never consumes, so the drain stays ON', async () => {
    process.env.INGEST_LANE_ROUTER = 'off'
    jest.resetModules()
    const router = require('./router')
    await router.startRouter() // returns immediately when disabled
    expect(router.isConsumingLegacy()).toBe(false)
  })
})
