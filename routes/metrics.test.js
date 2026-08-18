// ---------------------------------------------------------------------------
// The /metrics ROUTE must never let a rejection escape (2026-08-18).
//
// This is the SECOND half of the crash-loop fix, independent of the collector
// wrapper in services/prometheus.js:
//
//   services/prometheus.js  -> stops OUR two DB-backed gauges rejecting at all
//   routes/metrics.js       -> stops ANY rejection escaping the route
//
// Both are needed. The wrapper cannot cover prom-client's own
// collectDefaultMetrics, nor a future gauge added without it. Without the
// route's .catch(), such a rejection becomes an unhandledRejection and
// utils/process-handlers.js deliberately process.exit(1)s — a metrics scrape
// killing a serving pod, which is the 2026-08-17/18 incident.
//
// Ref: runbooks/FINDING-ingest-api-metrics-crashloop-2026-08-18.md (rfcx-local)
// ---------------------------------------------------------------------------

const express = require('express')
const request = require('supertest')

const BLIP = 'Connection terminated due to connection timeout'

// Rebuild the route against a controllable register, mirroring routes/metrics.js.
// (The real module reads PROMETHEUS_ENABLED at require time from env, so we mock
// the seam rather than fight module-level state.)
const buildApp = (registerMock, enabled = true) => {
  jest.resetModules()
  jest.doMock('../services/prometheus', () => ({
    PROMETHEUS_ENABLED: enabled,
    register: registerMock
  }))
  const app = express()
  app.use('/metrics', require('./metrics'))
  return app
}

let errorSpy
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
  jest.resetModules()
})

describe('GET /metrics', () => {
  test('serves metrics and resets the register on success', async () => {
    const resetMetrics = jest.fn()
    const app = buildApp({
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      metrics: jest.fn().mockResolvedValue('some_metric 1'),
      resetMetrics
    })

    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.text).toContain('some_metric 1')
    expect(resetMetrics).toHaveBeenCalled()
  })

  test('501 when metrics are disabled', async () => {
    const app = buildApp({ metrics: jest.fn() }, false)
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(501)
  })

  // THE REGRESSION GUARD.
  test('returns 500 (does NOT reject) when collection fails — the crash-loop guard', async () => {
    const app = buildApp({
      contentType: 'text/plain',
      metrics: jest.fn().mockRejectedValue(new Error(BLIP)),
      resetMetrics: jest.fn()
    })

    const res = await request(app).get('/metrics')
    expect(res.status).toBe(500)
    expect(errorSpy.mock.calls.flat().join(' ')).toContain(BLIP)
  })

  test('a failed scrape emits NO unhandledRejection — the process must survive', async () => {
    const seen = []
    const onUnhandled = (reason) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const app = buildApp({
        contentType: 'text/plain',
        metrics: jest.fn().mockRejectedValue(new Error(BLIP)),
        resetMetrics: jest.fn()
      })

      await request(app).get('/metrics')
      // give any stray microtask-scheduled rejection a chance to surface
      await new Promise(resolve => setImmediate(resolve))
      expect(seen).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  test('does not reset the register when collection failed', async () => {
    // resetMetrics is pushgateway-style: resetting after a FAILED gather would
    // discard histogram observations that were never actually exported.
    const resetMetrics = jest.fn()
    const app = buildApp({
      contentType: 'text/plain',
      metrics: jest.fn().mockRejectedValue(new Error(BLIP)),
      resetMetrics
    })

    await request(app).get('/metrics')
    expect(resetMetrics).not.toHaveBeenCalled()
  })
})
