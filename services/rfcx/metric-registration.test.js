/**
 * Every histogram name PUSHED anywhere in the codebase must be REGISTERED in
 * ingest.js's PROMETHEUS_ENABLED block (2026-08-26, §239 postmortem).
 *
 * WHY THIS EXISTS: pushHistogramMetric THROWS on an unregistered name. The
 * first release of the ingest claim pushed 'duplicate_event_skipped' without
 * registering it, so every duplicate-skip threw inside ingest(), the consumer
 * treated it as a handler failure, and NACKED the message to the DLQ (~4k
 * messages in 2h) -- with zero user-visible symptom, because the data-plane
 * outcome was still correct. Caught only by a DLQ-depth re-review pass.
 *
 * This test is STATIC (source-scan), deliberately: it does not need
 * PROMETHEUS_ENABLED, a metrics server, or any mocking, and it covers every
 * file, including ones added later.
 */
const fs = require('fs')
const path = require('path')

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) { continue }
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p, out) } else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) { out.push(p) }
  }
  return out
}

test('every pushHistogramMetric name has a matching registerHistogram', () => {
  const root = path.join(__dirname, '..', '..')
  const files = walk(root)

  const pushed = new Set()
  const registered = new Set()
  const pushRe = /pushHistogramMetric\(\s*'([^']+)'/g
  const regRe = /registerHistogram\(\s*'([^']+)'/g

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(pushRe)) { pushed.add(m[1]) }
    for (const m of src.matchAll(regRe)) { registered.add(m[1]) }
  }

  // Dynamic names (variables, template literals) can't be checked statically;
  // assert we at least saw the known literal ones so the test can't silently
  // decay into asserting nothing.
  expect(pushed.size).toBeGreaterThanOrEqual(3)
  expect(pushed).toContain('duplicate_event_skipped')

  // status-name pushes (getKeyByValue(db.status, ...)) and file-extension
  // pushes are registered via loops over db.status / supportedExtensions;
  // literal pushes matching those families are covered by the loops.
  const loopRegistered = ['WAITING', 'UPLOADED', 'INGESTED', 'FAILED', 'DUPLICATE', 'CHECKSUM']
  const unregistered = [...pushed].filter(
    name => !registered.has(name) && !loopRegistered.includes(name))

  expect(unregistered).toEqual([])
})
