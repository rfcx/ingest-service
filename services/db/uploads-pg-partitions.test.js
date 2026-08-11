// ---------------------------------------------------------------------------
// Partition lifecycle tests (mongo2pg S2b — migration 002).
//
// Retention on the partitioned store is DROP PARTITION, executed by
// ingest.drop_expired_partitions(). That function deletes DATA, so its
// boundary conditions are proven here, not assumed:
//   * a partition strictly older than the window is dropped
//   * a partition ON the boundary survives
//   * the DEFAULT partition is never touched
//   * ensure_partitions is idempotent
//   * rows keep routing correctly after a drop
// ---------------------------------------------------------------------------

const pgTesting = require('../../utils/testing/pg')

const pgConfigured = pgTesting.isConfigured()
const describePg = pgConfigured ? describe : describe.skip

beforeAll(async () => {
  if (!pgConfigured) { return }
  process.env.UPLOADS_DB = 'pg'
  await pgTesting.connect()
})

afterAll(async () => {
  if (!pgConfigured) { return }
  await pgTesting.disconnect()
  delete process.env.UPLOADS_DB
})

beforeEach(async () => {
  if (!pgConfigured) { return }
  await pgTesting.truncate()
})

async function q (text, params) {
  return pgTesting.getPool().query(text, params)
}

async function partitionNames () {
  const res = await q(`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE n.nspname = 'ingest' AND i.inhparent = 'ingest.stream_uploads'::regclass
    ORDER BY c.relname`)
  return res.rows.map(r => r.relname)
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

describePg('partition maintenance', () => {
  test('ensure_partitions creates the horizon and is idempotent', async () => {
    const first = await q('SELECT ingest.ensure_partitions(3) AS n')
    const second = await q('SELECT ingest.ensure_partitions(3) AS n')
    expect(second.rows[0].n).toBe(0) // second run creates nothing
    expect(first.rows[0].n).toBeGreaterThanOrEqual(0)
    const names = await partitionNames()
    expect(names).toContain(pname(0)) // today exists
    expect(names).toContain('stream_uploads_default')
  })

  test('rows route to their day partition; a row with an out-of-range created_at lands in DEFAULT (never lost)', async () => {
    await q('SELECT ingest.ensure_partitions(3)')
    const recent = await pgTesting.insertUpload({ createdAt: new Date() })
    // 400 days ago — no partition exists for it
    const ancient = await pgTesting.insertUpload({ createdAt: new Date(Date.now() - 400 * 86400000) })

    const inToday = await q(`SELECT count(*)::int AS c FROM ingest.${pname(0)} WHERE id = $1`, [recent])
    expect(inToday.rows[0].c).toBe(1)
    const inDefault = await q('SELECT count(*)::int AS c FROM ingest.stream_uploads_default WHERE id = $1', [ancient])
    expect(inDefault.rows[0].c).toBe(1)
    // both visible through the parent
    const total = await q('SELECT count(*)::int AS c FROM ingest.stream_uploads WHERE id IN ($1,$2)', [recent, ancient])
    expect(total.rows[0].c).toBe(2)
  })

  test('drop_expired_partitions drops strictly-older partitions, keeps the boundary and DEFAULT', async () => {
    await q('SELECT ingest.ensure_partitions(1)')
    await createPartitionFor(20) // clearly expired at 14d retention
    await createPartitionFor(14) // boundary: covers [d, d+1) with d = today-14; bound_to = today-13 > today-14 -> KEPT
    await createPartitionFor(5) // inside window

    await pgTesting.insertUpload({ createdAt: new Date(Date.now() - 20 * 86400000) })
    const keeper = await pgTesting.insertUpload({ createdAt: new Date(Date.now() - 5 * 86400000) })

    const dropped = await q('SELECT ingest.drop_expired_partitions(14) AS n')
    expect(dropped.rows[0].n).toBe(1) // only the 20-day-old one

    const names = await partitionNames()
    expect(names).not.toContain(pname(20))
    expect(names).toContain(pname(14))
    expect(names).toContain(pname(5))
    expect(names).toContain('stream_uploads_default')

    // the expired row went with its partition; the keeper survives
    const res = await q('SELECT count(*)::int AS c FROM ingest.stream_uploads')
    expect(res.rows[0].c).toBe(1)
    const kept = await q('SELECT count(*)::int AS c FROM ingest.stream_uploads WHERE id = $1', [keeper])
    expect(kept.rows[0].c).toBe(1)
  })

  test('drop_expired_partitions never touches the DEFAULT partition even with ancient rows in it', async () => {
    const ancient = await pgTesting.insertUpload({ createdAt: new Date(Date.now() - 400 * 86400000) })
    const before = await partitionNames()
    await q('SELECT ingest.drop_expired_partitions(14)')
    const after = await partitionNames()
    expect(after).toContain('stream_uploads_default')
    expect(after.length).toBe(before.length) // nothing dropped (only default + fresh horizon here)
    const row = await q('SELECT count(*)::int AS c FROM ingest.stream_uploads WHERE id = $1', [ancient])
    expect(row.rows[0].c).toBe(1)
  })

  test('the seam still finds uploads across partitions by id alone (PK is (id, created_at))', async () => {
    await q('SELECT ingest.ensure_partitions(1)')
    await createPartitionFor(5)
    const db = require('./uploads-pg')
    const oldId = await pgTesting.insertUpload({ createdAt: new Date(Date.now() - 5 * 86400000), streamId: 'old-day' })
    const newId = await pgTesting.insertUpload({ createdAt: new Date(), streamId: 'new-day' })
    expect((await db.getUpload(oldId)).streamId).toBe('old-day')
    expect((await db.getUpload(newId)).streamId).toBe('new-day')
  })
})
