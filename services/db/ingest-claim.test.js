/**
 * INGEST CLAIM — idempotency against duplicate EVENT delivery (2026-08-26).
 *
 * These tests pin the behaviour that the live incident actually needed, not
 * just the happy path:
 *   1. concurrent duplicate deliveries produce EXACTLY ONE winner
 *   2. an already-INGESTED upload is never re-ingested
 *   3. an EXPIRED claim is reclaimable (a crashed worker must not wedge a row)
 *   4. the guard refuses 20 -> 10 (the step that produced the false 31s)
 *   5. ...but 30 -> 10 (redrive) and reads of rows AT 10 still work, so the
 *      stuck-upload reaper's contract is untouched
 *
 * The pg Pool is mocked with a tiny in-memory row store that honours the
 * WHERE-clause semantics we depend on, so the SQL's *intent* is executed
 * rather than merely string-matched.
 * Record: runbooks/INCIDENT-2026-08-26-r2-event-fanout-duplicate-ingest.md
 */

const OID = 'a'.repeat(24)

// --- in-memory stand-in for the single table -------------------------------
let rows
let queryLog

function resetStore (initial = {}) {
  rows = {
    [OID]: {
      id: OID,
      status: 0,
      ingestion_result: null,
      failure_message: null,
      updated_at: null,
      ...initial
    }
  }
  queryLog = []
}

// Extremely small SQL interpreter: we only need to model the two statements
// this module issues. Anything else throws loudly rather than silently passing.
function fakeQuery (text, params) {
  queryLog.push(text.trim().split('\n')[0])
  const t = text.replace(/\s+/g, ' ').trim()

  // claimUploadForIngest
  if (t.startsWith('UPDATE ingest.stream_uploads SET ingestion_result = COALESCE')) {
    const [id, claimKey, owner, nowIso, expiresIso, terminal] = params
    const row = rows[id]
    if (!row) { return Promise.resolve({ rowCount: 0, rows: [] }) }
    if (row.status === terminal) { return Promise.resolve({ rowCount: 0, rows: [] }) }
    const existing = row.ingestion_result && row.ingestion_result[claimKey]
    const live = existing && existing.expiresAt && existing.expiresAt >= nowIso
    if (live) { return Promise.resolve({ rowCount: 0, rows: [] }) }
    row.ingestion_result = {
      ...(row.ingestion_result || {}),
      [claimKey]: { owner, at: nowIso, expiresAt: expiresIso }
    }
    return Promise.resolve({ rowCount: 1, rows: [{ id }] })
  }

  // releaseIngestClaim
  if (t.startsWith('UPDATE ingest.stream_uploads SET ingestion_result = ingestion_result -')) {
    const [id, claimKey] = params
    const row = rows[id]
    if (!row || !row.ingestion_result || !(claimKey in row.ingestion_result)) {
      return Promise.resolve({ rowCount: 0, rows: [] })
    }
    const next = { ...row.ingestion_result }
    delete next[claimKey]
    row.ingestion_result = next
    return Promise.resolve({ rowCount: 1, rows: [{ id }] })
  }

  // updateUploadStatus (guarded)
  if (t.startsWith('UPDATE ingest.stream_uploads SET status =')) {
    const id = params[0]
    const statusNumber = params[1]
    const guarded = params[6]
    const terminal = params[7]
    const row = rows[id]
    if (!row) { return Promise.resolve({ rowCount: 0, rows: [] }) }
    if (guarded && row.status === terminal) {
      return Promise.resolve({ rowCount: 0, rows: [] })
    }
    row.status = statusNumber
    return Promise.resolve({ rowCount: 1, rows: [{ ...row }] })
  }

  if (t.startsWith('SELECT status FROM ingest.stream_uploads')) {
    const row = rows[params[0]]
    return Promise.resolve(row ? { rowCount: 1, rows: [{ status: row.status }] } : { rowCount: 0, rows: [] })
  }
  if (t.startsWith('SELECT') && t.includes('FROM ingest.stream_uploads WHERE id')) {
    const row = rows[params[0]]
    return Promise.resolve(row ? { rowCount: 1, rows: [{ ...row }] } : { rowCount: 0, rows: [] })
  }
  throw new Error(`unmodelled SQL in test: ${t.slice(0, 120)}`)
}

// NOTE: jest.mock is HOISTED above this file's other statements, so the factory
// must not close over `fakeQuery` directly -- it is not initialised yet at
// hoist time. Dispatch through globalThis instead, which is resolved lazily at
// call time.
globalThis.__fakeQuery = (text, params) => fakeQuery(text, params)

jest.mock('pg', () => {
  class Pool {
    query (text, params) { return globalThis.__fakeQuery(text, params) }
    on () {}
    end () { return Promise.resolve() }
  }
  return { Pool }
})

let db
beforeAll(() => {
  process.env.UPLOADS_DB = 'pg'
  db = require('./uploads-pg')
})

beforeEach(() => resetStore())

describe('claimUploadForIngest', () => {
  test('grants the claim on a fresh row', async () => {
    const r = await db.claimUploadForIngest(OID)
    expect(r.claimed).toBe(true)
  })

  test('CONCURRENT duplicate deliveries produce exactly ONE winner', async () => {
    // The live fault: ~7 deliveries of the same object arriving within ~4s.
    const results = await Promise.all(
      Array.from({ length: 7 }, () => db.claimUploadForIngest(OID))
    )
    const winners = results.filter(r => r.claimed)
    expect(winners).toHaveLength(1)
    expect(results.filter(r => !r.claimed).every(r => r.reason === 'in-flight')).toBe(true)
  })

  test('an already-INGESTED upload is NEVER re-ingested', async () => {
    resetStore({ status: 20 })
    const r = await db.claimUploadForIngest(OID)
    expect(r.claimed).toBe(false)
    expect(r.reason).toBe('ingested')
    expect(r.status).toBe(20)
  })

  test('an EXPIRED claim is reclaimable, so a crashed worker cannot wedge a row', async () => {
    // A worker took the claim and died; its expiry is in the past.
    resetStore({
      ingestion_result: { _claim: { owner: 'dead', at: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:30:00.000Z' } }
    })
    const r = await db.claimUploadForIngest(OID)
    expect(r.claimed).toBe(true)
  })

  test('a LIVE claim blocks a second worker', async () => {
    const first = await db.claimUploadForIngest(OID)
    expect(first.claimed).toBe(true)
    const second = await db.claimUploadForIngest(OID)
    expect(second.claimed).toBe(false)
    expect(second.reason).toBe('in-flight')
  })

  test('releaseIngestClaim frees the row for a redrive', async () => {
    await db.claimUploadForIngest(OID)
    expect((await db.claimUploadForIngest(OID)).claimed).toBe(false)
    await db.releaseIngestClaim(OID)
    expect((await db.claimUploadForIngest(OID)).claimed).toBe(true)
  })

  test('a missing row reports reason=missing rather than throwing', async () => {
    rows = {}
    const r = await db.claimUploadForIngest(OID)
    expect(r.claimed).toBe(false)
    expect(r.reason).toBe('missing')
  })

  test('skip counters stay observable (the waste must not become invisible)', async () => {
    const before = db.getClaimSkippedTotal()
    await db.claimUploadForIngest(OID)
    await db.claimUploadForIngest(OID)
    expect(db.getClaimSkippedTotal()).toBe(before + 1)
  })
})

describe('terminal-success guard now also covers 20 -> 10', () => {
  test('refuses UPLOADED(10) on an INGESTED(20) row -- the step that made the false 31s', async () => {
    resetStore({ status: 20 })
    const row = await db.updateUploadStatus(OID, 10)
    expect(row.status).toBe(20) // unchanged
    expect(rows[OID].status).toBe(20)
  })

  test('still refuses 20 -> 31', async () => {
    resetStore({ status: 20 })
    await db.updateUploadStatus(OID, 31, 'Duplicate file. Matching sha1 signature already ingested.')
    expect(rows[OID].status).toBe(20)
  })

  test('ALLOWS 30 -> 10, so an operator redrive of a failed upload still works', async () => {
    resetStore({ status: 30 })
    await db.updateUploadStatus(OID, 10)
    expect(rows[OID].status).toBe(10)
  })

  test('ALLOWS 0 -> 10, the normal first transition', async () => {
    resetStore({ status: 0 })
    await db.updateUploadStatus(OID, 10)
    expect(rows[OID].status).toBe(10)
  })

  test('ALLOWS 10 -> 20, so nothing blocks a genuine success', async () => {
    resetStore({ status: 10 })
    await db.updateUploadStatus(OID, 20)
    expect(rows[OID].status).toBe(20)
  })

  test('the reaper contract is untouched: a row AT 10 is still reachable/settleable', async () => {
    resetStore({ status: 10 })
    // reaper Class A: settle to INGESTED
    await db.updateUploadStatus(OID, 20)
    expect(rows[OID].status).toBe(20)
    resetStore({ status: 10 })
    // reaper Class B: mark FAILED for redrive
    await db.updateUploadStatus(OID, 30, 'stuck')
    expect(rows[OID].status).toBe(30)
  })
})
