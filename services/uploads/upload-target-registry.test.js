const registry = require('./upload-target-registry')

describe('upload target registry policy selection', () => {
  const targets = [
    {
      id: 'legacy-env-upload-bucket',
      version: 1,
      provider: 's3-compatible',
      bucket: 'rfcx-ingest-production',
      endpoint: 'https://example.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true
    },
    {
      id: 'r2-enam-upload-bucket',
      version: 1,
      provider: 's3-compatible',
      bucket: 'rfcx-ingest-enam',
      endpoint: 'https://example.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true
    }
  ]

  test('falls back to first enabled target when no active policy exists', () => {
    expect(registry.selectTargetFromPolicy(targets, null)).toBe(targets[0])
  })

  test('selects target from active single-target policy', () => {
    const selected = registry.selectTargetFromPolicy(targets, {
      mode: 'single-target',
      targetId: 'r2-enam-upload-bucket'
    })

    expect(selected).toBe(targets[1])
  })

  test('rejects active policy that references a missing or disabled target', () => {
    expect(() => registry.selectTargetFromPolicy(targets, {
      mode: 'single-target',
      targetId: 'rfcx-ingest-eu'
    })).toThrow('Active upload target policy references disabled or missing target: rfcx-ingest-eu')
  })

  test('rejects unsupported policy modes', () => {
    expect(() => registry.selectTargetFromPolicy(targets, {
      mode: 'geo-weighted',
      targetId: 'r2-enam-upload-bucket'
    })).toThrow('Unsupported upload target policy mode: geo-weighted')
  })
})

// REGRESSION GUARD — see the comment on getPool() in upload-target-registry.js.
//
// A pg Pool with no 'error' listener turns an error on an IDLE client into an
// unhandled 'error' event, which becomes an uncaughtException and exits the
// process (process-handlers.js exits deliberately). In production this fires
// whenever the Patroni leader restarts and postgres terminates every client
// with "terminating connection due to administrator command".
//
// Verified against a real postgres 14 + pg 8.22 on 2026-08-22: without the
// listener the process exits 1; with it, the pool logs and reconnects.
// ingest-service-api crashed this way twice in 18h (2026-08-21 22:38Z,
// 2026-08-22 04:40Z). This test fails if the listener is ever removed.
describe('upload target registry pool resilience', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...OLD_ENV, UPLOAD_TARGET_REGISTRY_POSTGRES_HOSTNAME: 'localhost' }
  })

  afterEach(() => {
    process.env = OLD_ENV
    jest.resetModules()
  })

  test("registers a pool-level 'error' listener so an idle-client error cannot kill the process", async () => {
    const listeners = {}
    const fakePool = {
      on: jest.fn((event, handler) => { listeners[event] = handler }),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined)
    }

    jest.doMock('pg', () => ({ Pool: jest.fn(() => fakePool) }))

    const freshRegistry = require('./upload-target-registry')
    await freshRegistry.getEnabledUploadTargets()

    expect(fakePool.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(typeof listeners.error).toBe('function')

    // The handler must SWALLOW the error (log only). If it rethrew, the
    // unhandled 'error' would still terminate the process.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => listeners.error(new Error('terminating connection due to administrator command'))).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
