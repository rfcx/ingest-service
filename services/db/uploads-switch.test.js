// ---------------------------------------------------------------------------
// The UPLOADS_DB backend switch (mongo2pg S1).
//
// The single most important property: with UPLOADS_DB UNSET, the app resolves
// the Mongo backend — i.e. this whole change is inert until someone opts in.
// These tests use isolateModules so each case re-evaluates the require-time
// selection with a different environment.
//
// Requiring './uploads-pg' does NOT connect (the pool is lazy), so these run
// without any database.
// ---------------------------------------------------------------------------

const ORIGINAL = process.env.UPLOADS_DB

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.UPLOADS_DB
  } else {
    process.env.UPLOADS_DB = ORIGINAL
  }
})

/**
 * Resolve the switch and report WHICH backend it chose.
 *
 * Identity comparison against a separately-required module does not work here:
 * jest.isolateModules gives each isolated registry its own module instance, so
 * two requires of './mongo' are deep-equal but not `toBe`-equal. Instead the
 * backends are distinguished by a marker only one of them has (`_internal` is
 * exported by uploads-pg alone), which is also a real assertion about the
 * surface rather than an artefact of the test harness.
 */
function resolveBackendName () {
  let name
  jest.isolateModules(() => {
    const selected = require('./uploads')
    name = selected._internal ? 'pg' : 'mongo'
  })
  return name
}

describe('UPLOADS_DB switch', () => {
  test('defaults to the MONGO backend when UPLOADS_DB is unset (zero behaviour change)', () => {
    delete process.env.UPLOADS_DB
    expect(resolveBackendName()).toBe('mongo')
  })

  test('selects the PG backend only for an explicit "pg"', () => {
    process.env.UPLOADS_DB = 'pg'
    expect(resolveBackendName()).toBe('pg')
  })

  test('is case-insensitive for pg', () => {
    for (const value of ['PG', 'Pg', 'pG']) {
      process.env.UPLOADS_DB = value
      expect([value, resolveBackendName()]).toEqual([value, 'pg'])
    }
  })

  test('falls back to mongo for any unrecognised value (never fails closed into a half-configured state)', () => {
    for (const value of ['mongo', 'MONGO', '', 'postgres', 'postgresql', 'nonsense', ' pg']) {
      process.env.UPLOADS_DB = value
      expect([value, resolveBackendName()]).toEqual([value, 'mongo'])
    }
  })

  test('both backends expose the SAME function surface (a caller cannot depend on an engine-only method)', () => {
    let mongo, pg
    jest.isolateModules(() => { mongo = require('./mongo') })
    jest.isolateModules(() => { pg = require('./uploads-pg') })

    // Everything the app calls through the seam must exist on both.
    const required = [
      'generateUpload', 'getPendingProjectDuration', 'setUploadMultipart',
      'setUploadMultipartCompleted', 'setUploadMultipartAborted', 'getUpload',
      'getUploadDuplicateCount', 'getUploadFailedCount', 'updateUploadStatus',
      'getOrCreateHealthCheck', 'findCleanupCandidates', 'markUploadSourceDeleted'
    ]
    for (const name of required) {
      expect(typeof mongo[name]).toBe('function')
      expect(typeof pg[name]).toBe('function')
    }
    expect(pg.status).toEqual(mongo.status)
  })

  test('the PG backend does NOT carry the dead DeploymentInfo surface (dropped, not migrated)', () => {
    let pg
    jest.isolateModules(() => { pg = require('./uploads-pg') })
    expect(pg.getDeploymentInfo).toBeUndefined()
    expect(pg.saveDeploymentInfo).toBeUndefined()
    expect(pg.updateDeploymentInfo).toBeUndefined()
  })
})

describe('utils/uploads-db helper', () => {
  test('isPostgresUploads reflects the flag and defaults to false', () => {
    let helper
    jest.isolateModules(() => { helper = require('../../utils/uploads-db') })
    delete process.env.UPLOADS_DB
    expect(helper.isPostgresUploads()).toBe(false)
    process.env.UPLOADS_DB = 'pg'
    expect(helper.isPostgresUploads()).toBe(true)
    process.env.UPLOADS_DB = 'mongo'
    expect(helper.isPostgresUploads()).toBe(false)
  })
})
