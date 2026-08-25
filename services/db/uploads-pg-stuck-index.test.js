// ---------------------------------------------------------------------------
// Stuck-upload reaper index tests (migration 002, added 2026-08-24).
//
// WHY THIS FILE EXISTS. The reaper's scan is
//   status = 10 AND updated_at <= cutoff ORDER BY updated_at LIMIT n
// and until 2026-08-24 no index served it. The only candidate was
// `(project_id) WHERE status IN (0,10)`, whose leading column the query does
// not filter on, so the planner degenerated to a full partial-index scan or a
// Seq Scan on EVERY daily partition: 13,357 shared buffers touched to return
// ZERO rows. That blew the uploads pool's 5s statement_timeout under load and
// the CronJob FAILED 2 of 5 runs -- the stuck-upload safety net went down
// exactly when the system was busiest and a stall was most likely.
//
// These tests pin the properties that make the fix correct, so a future schema
// edit cannot silently undo them:
//   * the index EXISTS on the parent and is partial on status=10
//   * it PROPAGATES to every partition, including ones created later
//   * the planner actually USES it for the reaper's query shape
//   * it does NOT index status=0 rows (that population is 75k+ and irrelevant;
//     indexing it is what made the old index useless)
//   * findStuckUploads still returns the right rows (correctness, not just speed)
// ---------------------------------------------------------------------------

const pgTesting = require('../../utils/testing/pg')

const pgConfigured = pgTesting.isConfigured()
const describePg = pgConfigured ? describe : describe.skip

const INDEX = 'stream_uploads_stuck_idx'

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

/**
 * Insert a row directly so we control status + updated_at precisely.
 * NOTE: `id` is char(24) and `upload_source` is jsonb (not text) -- both bit
 * me writing this file, and both are exactly the kind of thing an in-memory
 * fake would not have caught.
 */
async function insertUpload ({ id, status, updatedAgoHours = 0, createdAgoDays = 0 }) {
  const created = new Date(Date.now() - createdAgoDays * 86400000)
  const updated = new Date(Date.now() - updatedAgoHours * 3600000)
  await q(`
    INSERT INTO ingest.stream_uploads
      (id, stream_id, user_id, project_id, status, lane_tier, "timestamp",
       duration, original_filename, checksum, upload_source, created_at, updated_at)
    VALUES ($1,'s1','u1','p1',$2,'standard',now(),60,'rec.wav',$3,$4::jsonb,$5,$6)`,
  [id.padEnd(24, '0'), status, 'sha-' + id, JSON.stringify({ kept: true }), created, updated])
}

/** char(24) comes back space/zero padded; compare on the padded form. */
const pad = (id) => id.padEnd(24, '0')

describePg('stuck-upload reaper index', () => {
  test('exists on the parent, partial on status=10, keyed by updated_at', async () => {
    const res = await q(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname='ingest' AND indexname=$1`, [INDEX])
    expect(res.rows).toHaveLength(1)
    const def = res.rows[0].indexdef
    // keyed by updated_at so it serves BOTH the range predicate and the ORDER BY
    expect(def).toMatch(/\(updated_at\)/)
    // partial on status=10 so it stays tiny and skips the 75k status=0 rows
    expect(def).toMatch(/WHERE \(?status = 10\)?/)
  })

  test('propagates to EVERY existing partition', async () => {
    // Match on the PREDICATE, not the name. An earlier version of this test
    // matched any index named %updated_at%, which also matches the
    // pre-existing cleanup_idx (updated_at) -- so it passed with the fix
    // ABLATED. Caught by ablation, not review.
    const res = await q(`
      SELECT count(*)::int AS partitions,
             count(*) FILTER (WHERE has_stuck)::int AS with_index
      FROM (
        SELECT c.relname,
               EXISTS (
                 SELECT 1 FROM pg_index i
                 JOIN pg_class ic ON ic.oid = i.indexrelid
                 WHERE i.indrelid = c.oid
                   AND pg_get_indexdef(i.indexrelid) LIKE '%WHERE (status = 10)%'
               ) AS has_stuck
        FROM pg_class c
        JOIN pg_inherits inh ON inh.inhrelid = c.oid
        WHERE inh.inhparent = 'ingest.stream_uploads'::regclass
      ) t`)
    const { partitions, with_index: withIndex } = res.rows[0]
    expect(partitions).toBeGreaterThan(0)
    expect(withIndex).toBe(partitions)
  })

  test('a partition created LATER also inherits it', async () => {
    // Days roll over; a partition made tomorrow by ensure_partitions() must get
    // the index too, or the reaper silently degrades again over time.
    const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
    const name = 'stream_uploads_p' + day.replace(/-/g, '')
    await q('SELECT ingest.ensure_partitions_range($1::date, $1::date)', [day])

    const res = await q(`
      SELECT count(*)::int AS n FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relname = $1
        AND pg_get_indexdef(i.indexrelid) LIKE '%WHERE (status = 10)%'`, [name])
    expect(res.rows[0].n).toBe(1)

    await q(`DROP TABLE IF EXISTS ingest.${name}`)
  })

  test('does NOT index status=0 rows (the population that made the old index useless)', async () => {
    for (let i = 0; i < 5; i++) {
      await insertUpload({ id: 'w' + i, status: 0, updatedAgoHours: 24 })
    }

    // idx_tup_read/scan is unreliable without ANALYZE; assert on the predicate
    // semantics instead: a partial index cannot contain non-matching rows.
    const res = await q(`
      SELECT count(*)::int AS n FROM ingest.stream_uploads WHERE status = 0`)
    expect(res.rows[0].n).toBe(5)

    // the index is defined WHERE status=10, so none of the above can be in it
    const def = await q(`
      SELECT indexdef FROM pg_indexes WHERE schemaname='ingest' AND indexname=$1`, [INDEX])
    expect(def.rows[0].indexdef).toMatch(/WHERE \(?status = 10\)?/)
  })

  test('the planner picks THIS index for the reaper query shape', async () => {
    // An earlier version asserted the plan text merely contained "updated_at",
    // which the ORDER BY guarantees whether or not the index exists -- it
    // passed with the fix ABLATED. Assert the index NAME instead.
    await insertUpload({ id: 'u1', status: 10, updatedAgoHours: 24 })
    await q('ANALYZE ingest.stream_uploads')

    // seqscan off removes small-table noise: on a near-empty table a Seq Scan
    // is legitimately cheapest, so this asks "is the index USABLE for this
    // shape", which is the property that failed in production.
    await q('SET enable_seqscan = off')
    const res = await q(`
      EXPLAIN (FORMAT TEXT)
      SELECT id FROM ingest.stream_uploads
      WHERE status = ANY(ARRAY[10]::smallint[])
        AND updated_at <= now() - interval '3 hours'
        AND stream_id IS NOT NULL AND checksum IS NOT NULL
      ORDER BY updated_at ASC LIMIT 200`)
    await q('RESET enable_seqscan')

    const plan = res.rows.map(r => r['QUERY PLAN']).join('\n')

    // PG names the CHILD indexes after the column (`..._updated_at_idx1`), not
    // after the parent index, so asserting /stuck_idx/ fails even when the fix
    // is working -- caught by running the restored suite, not by review.
    // Identify it by OID instead: collect the child index names that actually
    // carry the `status = 10` predicate, and require the plan to use one.
    const kids = await q(`
      SELECT ic.relname FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_inherits inh ON inh.inhrelid = c.oid
      WHERE inh.inhparent = 'ingest.stream_uploads'::regclass
        AND pg_get_indexdef(i.indexrelid) LIKE '%WHERE (status = 10)%'`)
    const names = kids.rows.map(r => r.relname)
    expect(names.length).toBeGreaterThan(0)
    expect(names.some(n => plan.includes(n))).toBe(true)

    // and it must be an index scan, not a re-sort of everything
    expect(plan).toMatch(/Index Scan/)
  })

  test('findStuckUploads returns only status=10 rows older than the cutoff', async () => {
    const db = require('./uploads-pg')
    await insertUpload({ id: 'old10', status: 10, updatedAgoHours: 24 }) // want
    await insertUpload({ id: 'new10', status: 10, updatedAgoHours: 0 }) // too fresh
    await insertUpload({ id: 'old0', status: 0, updatedAgoHours: 24 }) // wrong status
    await insertUpload({ id: 'old20', status: 20, updatedAgoHours: 24 }) // terminal

    const rows = await db.findStuckUploads({
      statuses: [10],
      updatedBefore: new Date(Date.now() - 3 * 3600000),
      limit: 200
    })
    expect(rows.map(r => r.id.trim())).toEqual([pad('old10')])
  })

  test('findStuckUploads orders oldest-first and respects the limit', async () => {
    const db = require('./uploads-pg')
    await insertUpload({ id: 'a', status: 10, updatedAgoHours: 10 })
    await insertUpload({ id: 'b', status: 10, updatedAgoHours: 30 })
    await insertUpload({ id: 'c', status: 10, updatedAgoHours: 20 })

    const rows = await db.findStuckUploads({
      statuses: [10],
      updatedBefore: new Date(Date.now() - 3 * 3600000),
      limit: 2
    })
    // oldest first: b (30h) then c (20h); 'a' excluded by the limit
    expect(rows.map(r => r.id.trim())).toEqual([pad('b'), pad('c')])
  })
})
