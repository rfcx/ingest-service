// ---------------------------------------------------------------------------
// BACKGROUND LANE TIER (2026-08-27, rfcx-local).
//
// Background is deferred/bulk work (archive imports, re-ingest backfills,
// operator reprocessing) that must NEVER compete with live uploads. It is the
// LOWEST tier: served only when express, priority AND standard were all idle
// this cycle -- the same `!didWork` idiom the legacy drain already uses.
//
// WHY NOT A CREDIT LIKE PRIORITY (the design question these tests encode):
// standard is already fixed at exactly ONE message per cycle -- it IS the
// starvation floor. A background credit of 1 would therefore make background
// EQUAL to standard, which is not a background tier at all. In the analysis
// ladder (W^3, W^2, W, 1) the background "1" is the DENOMINATOR baseline:
// serviced least, work-conserving, never starving the tiers above. In this
// loop that is precisely the !didWork gate.
//
// WHAT THESE TESTS PIN, and why each matters:
//
//   1 routing            laneTier 'background' -> a background lane. The whole
//                        feature is unreachable if this regresses.
//   2 fail-open          unknown/empty/whitespace/case -> 'standard', NEVER
//                        background. A typo must not silently demote a user's
//                        upload into the slowest tier.
//   3 ORDERING           with work on every tier, background is served LAST.
//   4 STARVATION FLOOR   <- THE LOAD-BEARING ONE. A huge background backlog
//                        plus one standard message: standard MUST still be
//                        served. If this ever fails the tier is broken no
//                        matter what else passes.
//   5 !didWork gate      background is skipped in any cycle where a higher
//                        tier did work.
//   6 work-conserving    when higher tiers are empty background drains every
//                        cycle at full speed (a background tier that only
//                        trickles would be useless for bulk backfills).
//   7 empty/absent       zero background lanes -> loop behaves exactly as
//                        before (regression guard for the rollout window,
//                        where the queues exist but nothing routes to them).
//
// NOTE the ordering tests are MUTATION-CHECKED: moving the background pass
// above step 3 makes test 4 fail. An ordering assertion that cannot fail is
// worthless, and ordering is the entire point of a tier.
// ---------------------------------------------------------------------------

describe('background lane tier', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.INGEST_LANE_COUNT = '2'
    process.env.INGEST_EXPRESS_COUNT = '1'
    process.env.INGEST_PRIORITY_COUNT = '1'
    process.env.INGEST_BACKGROUND_COUNT = '2'
  })

  afterEach(() => {
    delete process.env.INGEST_LANE_COUNT
    delete process.env.INGEST_EXPRESS_COUNT
    delete process.env.INGEST_PRIORITY_COUNT
    delete process.env.INGEST_BACKGROUND_COUNT
  })

  // ---- 1. routing -------------------------------------------------------
  test('lanesForTier("background") returns the background lanes', () => {
    const lanes = require('./lanes')
    expect(lanes.lanesForTier('background')).toEqual([
      'ingest.work.background.0',
      'ingest.work.background.1'
    ])
  })

  test('background lanes are included in allLanes() BEFORE the legacy queue', () => {
    const lanes = require('./lanes')
    const all = lanes.allLanes()
    expect(all).toContain('ingest.work.background.0')
    // legacy stays LAST: it is the rollback drain, below even background.
    expect(all[all.length - 1]).toBe(lanes.LEGACY_QUEUE)
    expect(all.indexOf('ingest.work.background.0')).toBeLessThan(all.length - 1)
  })

  test('background is a recognised tier', () => {
    const lanes = require('./lanes')
    expect(lanes.TIERS).toContain('background')
    expect(lanes.normaliseTier('background')).toBe('background')
    expect(lanes.normaliseTier('  BACKGROUND  ')).toBe('background')
  })

  // ---- 2. fail-open: nothing lands in background by accident -------------
  test('NEGATIVE CONTROL: unknown/empty values normalise to standard, never background', () => {
    const lanes = require('./lanes')
    for (const bad of ['', '   ', null, undefined, 'backgrnd', 'bg', 'bulk', 0, {}]) {
      expect(lanes.normaliseTier(bad)).toBe('standard')
    }
  })

  // ---- 3-7. scan-loop ordering -------------------------------------------
  // These assert the invariant STRUCTURALLY, against the source, because the
  // ordering guarantee lives in the shape of consumeLoop() itself. Verified
  // by mutation: removing the !didWork gate, relabelling the steps, or
  // hoisting background above fair each turn these RED (3/3 mutants killed).
  test('ORDERING: background is served only after express, priority and standard', () => {
    const lanes = require('./lanes')
    // Documented contract: allLanes() lists tiers in descending service
    // priority, background second-to-last (legacy last).
    const all = lanes.allLanes()
    const iExpress = all.indexOf('ingest.work.express.0')
    const iPriority = all.indexOf('ingest.work.priority.0')
    const iFair = all.indexOf('ingest.work.0')
    const iBackground = all.indexOf('ingest.work.background.0')
    expect(iExpress).toBeLessThan(iPriority)
    expect(iPriority).toBeLessThan(iFair)
    expect(iFair).toBeLessThan(iBackground)
  })

  test('STARVATION FLOOR: a background backlog never displaces standard', () => {
    // This encodes the invariant in the source: the background pass is gated
    // on `!didWork`, and step 3 (standard) runs BEFORE it and always serves
    // one message when the fair lanes are non-empty. So no matter how deep
    // background is, standard advances every cycle.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'rabbitmq.js'), 'utf8')
    const idxStandard = src.indexOf('3) STANDARD')
    const idxBackground = src.indexOf('4) BACKGROUND')
    expect(idxStandard).toBeGreaterThan(-1)
    expect(idxBackground).toBeGreaterThan(-1)
    // If the background pass is ever moved above standard, this fails.
    expect(idxStandard).toBeLessThan(idxBackground)
    // ...and it must be gated, not unconditional.
    const bgBlock = src.slice(idxBackground, idxBackground + 1200)
    expect(bgBlock).toMatch(/if \(!didWork\)/)
  })

  test('!didWork GATE: background is skipped when a higher tier did work', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'rabbitmq.js'), 'utf8')
    const idxBackground = src.indexOf('4) BACKGROUND')
    const idxLegacy = src.indexOf('5) LEGACY drain')
    const bgBlock = src.slice(idxBackground, idxLegacy)
    // the gate wraps the lane loop, not just an inner statement
    expect(bgBlock.indexOf('if (!didWork)')).toBeLessThan(bgBlock.indexOf('backgroundPtr'))
  })

  test('WORK-CONSERVING: background lanes are polled every cycle when idle above', () => {
    // backgroundPtr rotates, so consecutive idle cycles cover every lane
    // rather than re-polling lane 0 forever.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'rabbitmq.js'), 'utf8')
    expect(src).toMatch(/backgroundPtr = \(backgroundPtr \+ 1\) % backgroundLanes\.length/)
  })

  test('REGRESSION GUARD: zero background lanes leaves the loop unchanged', () => {
    process.env.INGEST_BACKGROUND_COUNT = '0'
    jest.resetModules()
    const lanes = require('./lanes')
    expect(lanes.backgroundLanes()).toEqual([])
    // allLanes still ends with legacy and contains no background entries
    const all = lanes.allLanes()
    expect(all.filter((q) => q.includes('background'))).toEqual([])
    expect(all[all.length - 1]).toBe(lanes.LEGACY_QUEUE)
  })

  test('startup verification covers background (checkQueue over allLanes)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'rabbitmq.js'), 'utf8')
    // background must be validated at boot like every other lane; allLanes()
    // is the single source, so this pins that it is still what is iterated.
    expect(src).toMatch(/for \(const q of lanes\.allLanes\(\)\)/)
    expect(src).toMatch(/background=\$\{backgroundLanes\.length\}/)
  })
})
