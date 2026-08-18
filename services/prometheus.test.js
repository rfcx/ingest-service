// ---------------------------------------------------------------------------
// A metrics scrape must NEVER kill the process (2026-08-18).
//
// Production incident: ~20 restarts on each ingest-service-api replica (and 14
// on a tasks pod) because @rfcx/prometheus-metrics' Gauge awaits its callback
// with no error handling, prom-client gathers gauges under Promise.all, and
// utils/process-handlers.js deliberately exits on unhandledRejection. A DB blip
// during the 30s Prometheus scrape therefore took the pod down.
//
// These tests pin the wrapper's contract AND reproduce the real mechanism
// end-to-end through actual prom-client, so a regression cannot pass by only
// satisfying the unit-level assertions.
//
// Ref: runbooks/FINDING-ingest-api-metrics-crashloop-2026-08-18.md (rfcx-local)
// ---------------------------------------------------------------------------

const { nonFatalCollector } = require('./prometheus')

const DB_BLIP = () => new Error('Connection terminated due to connection timeout')

let errorSpy
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('nonFatalCollector', () => {
  test('passes a successful value straight through', async () => {
    const collect = nonFatalCollector(async () => 42, 'uploads_failed')
    await expect(collect()).resolves.toBe(42)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('RESOLVES (never rejects) when the underlying query fails — the whole point', async () => {
    const collect = nonFatalCollector(async () => { throw DB_BLIP() }, 'uploads_failed')
    await expect(collect()).resolves.toBe(0)
    expect(errorSpy).toHaveBeenCalled()
  })

  test('reports 0 when it fails before any successful read', async () => {
    const collect = nonFatalCollector(async () => { throw DB_BLIP() }, 'uploads_failed')
    await expect(collect()).resolves.toBe(0)
    expect(errorSpy.mock.calls[0].join(' ')).toContain('no previous value yet')
  })

  test('serves the LAST GOOD value on a later failure, rather than dipping to 0', async () => {
    // A dip to 0 is indistinguishable from a real drop to zero and could
    // silently satisfy or fire a threshold alert. Staleness is the safer lie.
    let mode = 'ok'
    const collect = nonFatalCollector(async () => {
      if (mode === 'fail') { throw DB_BLIP() }
      return 7
    }, 'uploads_failed')

    await expect(collect()).resolves.toBe(7)
    mode = 'fail'
    await expect(collect()).resolves.toBe(7)
    expect(errorSpy.mock.calls[0].join(' ')).toContain('last good value 7')
  })

  test('recovers to live values once the DB comes back', async () => {
    let mode = 'ok'
    const collect = nonFatalCollector(async () => {
      if (mode === 'fail') { throw DB_BLIP() }
      return mode === 'ok' ? 3 : 99
    }, 'uploads_duplicated')

    await expect(collect()).resolves.toBe(3)
    mode = 'fail'
    await expect(collect()).resolves.toBe(3)
    mode = 'recovered'
    await expect(collect()).resolves.toBe(99)
  })

  test('treats a non-numeric result as a failure (prom-client would throw on it)', async () => {
    // pg returns bigint as a string; a backend that forgets to Number() it would
    // otherwise throw INSIDE prom-client — the same unhandled-rejection path.
    const collect = nonFatalCollector(async () => ({ rows: [{ count: '5' }] }), 'uploads_failed')
    await expect(collect()).resolves.toBe(0)
    expect(errorSpy.mock.calls[0].join(' ')).toContain('non-numeric')
  })

  test('coerces a numeric STRING (pg bigint shape) rather than rejecting it', async () => {
    const collect = nonFatalCollector(async () => '12', 'uploads_failed')
    await expect(collect()).resolves.toBe(12)
  })

  test('survives a synchronously-throwing collector, not just a rejected promise', async () => {
    const collect = nonFatalCollector(() => { throw DB_BLIP() }, 'uploads_failed')
    await expect(collect()).resolves.toBe(0)
  })

  test('names the failing gauge in the log so the cause is identifiable in seconds', async () => {
    const collect = nonFatalCollector(async () => { throw DB_BLIP() }, 'uploads_duplicated')
    await collect()
    expect(errorSpy.mock.calls[0].join(' ')).toContain('uploads_duplicated')
  })
})

// ---------------------------------------------------------------------------
// END-TO-END REPRODUCTION through real prom-client + the real Gauge shape.
//
// This is the test that actually proves the incident cannot recur: it drives
// `registry.metrics()` (the exact call the /metrics route makes) with a failing
// DB-backed gauge, under a listener that fails the test on unhandledRejection.
// ---------------------------------------------------------------------------
describe('registry.metrics() with a failing DB-backed gauge (real prom-client)', () => {
  const client = require('prom-client')

  // Mirrors @rfcx/prometheus-metrics' Gauge exactly — an async collect() that
  // awaits the supplied callback. That package is a third-party dependency we
  // cannot patch, so the wrapper is applied at the CALL SITE; this reproduces
  // the vulnerable shape to prove the wrapper neutralises it.
  const makeVendorGauge = (register, name, func) => {
    const gauge = new client.Gauge({
      name,
      help: name,
      async collect () { this.set(await func()) }
    })
    register.registerMetric(gauge)
    return gauge
  }

  test('UNWRAPPED collector rejects the scrape — the bug, reproduced', async () => {
    const register = new client.Registry()
    makeVendorGauge(register, 'repro_unwrapped', async () => { throw DB_BLIP() })
    // This rejection is what became an unhandledRejection -> process.exit(1).
    await expect(register.metrics()).rejects.toThrow('Connection terminated')
  })

  test('WRAPPED collector lets the scrape SUCCEED and still serves the metric', async () => {
    const register = new client.Registry()
    makeVendorGauge(register, 'repro_wrapped', nonFatalCollector(async () => { throw DB_BLIP() }, 'repro_wrapped'))

    const output = await register.metrics()
    expect(output).toContain('repro_wrapped 0')
  })

  test('a failing gauge does not poison OTHER metrics in the same scrape', async () => {
    // The real registry gathers under Promise.all — one rejection fails the
    // whole scrape, taking healthy metrics with it.
    const register = new client.Registry()
    makeVendorGauge(register, 'repro_healthy', nonFatalCollector(async () => 5, 'repro_healthy'))
    makeVendorGauge(register, 'repro_broken', nonFatalCollector(async () => { throw DB_BLIP() }, 'repro_broken'))

    const output = await register.metrics()
    expect(output).toContain('repro_healthy 5')
    expect(output).toContain('repro_broken 0')
  })

  test('no unhandledRejection is emitted across a failing scrape', async () => {
    const seen = []
    const onUnhandled = (reason) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const register = new client.Registry()
      makeVendorGauge(register, 'repro_no_unhandled', nonFatalCollector(async () => { throw DB_BLIP() }, 'repro_no_unhandled'))
      await register.metrics()
      // let any stray microtask-scheduled rejection surface
      await new Promise(resolve => setImmediate(resolve))
      expect(seen).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })
})
