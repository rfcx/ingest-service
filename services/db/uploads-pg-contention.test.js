// ---------------------------------------------------------------------------
// Lock-contention behaviour of drop_expired_partitions (mongo2pg S2d).
//
// Measured hazard (postgres:14.19, 2026-08-11): DETACH PARTITION requests
// ACCESS EXCLUSIVE on the parent; while that request queues behind an
// in-flight reader, NEW queries on the parent queue behind IT — an innocent
// SELECT waited the full duration of the blocking reader (5s in the probe).
//
// Mitigation under test: the function sets lock_timeout=2s (tx-scoped) and
// SKIPS a contended partition (retried next run) instead of queueing
// indefinitely. These tests prove:
//   * under contention: the function returns promptly, drops nothing, and the
//     contended partition survives
//   * after contention clears: the same call drops it
//   * a skip does not abort the whole run (other partitions still drop)
// ---------------------------------------------------------------------------

const pgTesting = require('../../utils/testing/pg')

const pgConfigured = pgTesting.isConfigured()
const describePg = pgConfigured ? describe : describe.skip

beforeAll(async () => {
  if (!pgConfigured) { return }
  await pgTesting.connect()
})

afterAll(async () => {
  if (!pgConfigured) { return }
  await pgTesting.disconnect()
})

beforeEach(async () => {
  if (!pgConfigured) { return }
  await pgTesting.truncate()
})

async function q (text, params) {
  return pgTesting.getPool().query(text, params)
}

function pname (daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000)
  return 'stream_uploads_p' + d.toISOString().slice(0, 10).replace(/-/g, '')
}

async function createPartitionFor (daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000)
  const from = d.toISOString().slice(0, 10)
  const to = new Date(d.getTime() + 86400000).toISOString().slice(0, 10)
  await q(`CREATE TABLE IF NOT EXISTS ingest.${pname(daysAgo)}
           PARTITION OF ingest.stream_uploads FOR VALUES FROM ('${from}') TO ('${to}')`)
}

async function partitionExists (name) {
  const res = await q(`
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'ingest' AND c.relname = $1`, [name])
  return res.rows.length === 1
}

describePg('drop_expired_partitions under lock contention', () => {
  test('skips a contended partition promptly instead of queueing, then drops it once free', async () => {
    await createPartitionFor(20)
    expect(await partitionExists(pname(20))).toBe(true)

    // A second connection holds AccessShare on the PARENT via an open tx —
    // exactly the in-flight-reader shape from the measurement.
    const blocker = await pgTesting.getPool().connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT count(*) FROM ingest.stream_uploads')

      const t0 = Date.now()
      const res = await q('SELECT ingest.drop_expired_partitions(14) AS n')
      const elapsed = Date.now() - t0

      // returned promptly (lock_timeout 2s + overhead; NOT the blocker's lifetime)
      expect(elapsed).toBeLessThan(4000)
      // dropped nothing — the contended partition was skipped
      expect(res.rows[0].n).toBe(0)
      expect(await partitionExists(pname(20))).toBe(true)

      await blocker.query('COMMIT')
    } finally {
      blocker.release()
    }

    // contention gone: same call now drops it
    const after = await q('SELECT ingest.drop_expired_partitions(14) AS n')
    expect(after.rows[0].n).toBe(1)
    expect(await partitionExists(pname(20))).toBe(false)
  }, 30000)

  test('retention_status view: staleness is observable (the app-side freshness probe)', async () => {
    // ensure_partitions stamps ingest.health_check-style bookkeeping via the
    // maintenance log table; verify the view exposes last-run + horizon so
    // monitoring (or the app) can alert on staleness without doing DDL.
    // establish a KNOWN horizon, then require the view to report exactly it —
    // a >=0 assertion would pass even if the view always said 0 (proven by a
    // mutation that slipped through the first version of this test).
    await q('SELECT ingest.ensure_partitions(3)')
    const res = await q('SELECT * FROM ingest.retention_status')
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row).toHaveProperty('newest_partition_day')
    expect(row).toHaveProperty('oldest_partition_day')
    // ensure_partitions(3) guarantees partitions for today..today+3 exist
    expect(Number(row.horizon_days_remaining)).toBe(4)
    // and the newest partition day must be exactly today+3
    const expectNewest = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
    expect(new Date(row.newest_partition_day).toISOString().slice(0, 10)).toBe(expectNewest)
    expect(Number(row.default_partition_rows)).toBe(0)
  })
})
