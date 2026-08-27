// ---------------------------------------------------------------------------
// GRACEFUL DRAIN ON SIGTERM (2026-08-27, rfcx-local §242).
//
// Without a drain, a pod deletion (KEDA scale-down, rollout) killed the
// consumer mid-ingest. The in-flight message requeued, but its redelivery was
// claim-skipped + ACKED against the dead worker's still-fresh claim (claim TTL
// 30 min >> redelivery seconds), wedging the upload at status 10 until the 3h
// reaper marked it FAILED. Measured live 2026-08-27: 13 wedged rows in one
// 45-min scale flap.
//
// WHAT THESE TESTS PIN:
//   1. after SIGTERM, NO new messages are picked up (every lane loop stands
//      down), while an in-flight ingest RUNS TO COMPLETION and is acked;
//   2. consumeLoop resolves 'drained' (instead of throwing) so the reconnect
//      wrapper can exit 0 — a THROW would reconnect and keep consuming;
//   3. connectWithRetry calls process.exit(0) after a drain — a clean k8s
//      termination, not a crash;
//   4. control: without a term request the loop keeps pulling messages (the
//      drain flag must not break normal operation);
//   5. the module still fails fast on a connection drop (stopped path
//      unchanged: throw -> reconnect).
// ---------------------------------------------------------------------------

describe('graceful drain on SIGTERM', () => {
  const QUEUES = ['ingest.work.express.0', 'ingest.work.priority.0', 'ingest.work.0', 'ingest-service-upload-production']

  let rabbitmq
  let ingestMock
  let channel
  let connection
  let getCalls
  let acks
  let nacks
  let messageSupply

  function fakeMsg (n) {
    return {
      content: Buffer.from(JSON.stringify({
        Records: [{ eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'b', arn: 'a' }, object: { key: `stream/0123456789abcdef${String(n).padStart(4, '0')}.wav`, size: 1 } } }]
      }))
    }
  }

  beforeEach(() => {
    jest.resetModules()
    process.env.RABBITMQ_URL = 'amqp://test'
    process.env.INGEST_LANE_COUNT = '1'
    process.env.INGEST_EXPRESS_COUNT = '1'
    process.env.INGEST_PRIORITY_COUNT = '1'
    process.env.INGEST_LANE_ROUTER = 'off'
    getCalls = 0
    acks = 0
    nacks = 0
    messageSupply = []

    channel = {
      on: jest.fn(),
      checkQueue: jest.fn(async () => ({ messageCount: 0 })),
      get: jest.fn(async () => { getCalls += 1; return messageSupply.length ? messageSupply.shift() : false }),
      ack: jest.fn(() => { acks += 1 }),
      nack: jest.fn(() => { nacks += 1 }),
      close: jest.fn(async () => {})
    }
    connection = {
      on: jest.fn(),
      createChannel: jest.fn(async () => channel),
      close: jest.fn(async () => {})
    }

    jest.doMock('amqplib', () => ({ connect: jest.fn(async () => connection) }))
    ingestMock = jest.fn(async () => ({ outcome: 'ingested' }))
    jest.doMock('../rfcx/ingest', () => ({ ingest: ingestMock }))

    rabbitmq = require('./rabbitmq')
    rabbitmq._setTermRequestedForTest(false)
  })

  afterEach(() => {
    jest.dontMock('amqplib')
    jest.dontMock('../rfcx/ingest')
    delete process.env.RABBITMQ_URL
    delete process.env.INGEST_LANE_COUNT
    delete process.env.INGEST_EXPRESS_COUNT
    delete process.env.INGEST_PRIORITY_COUNT
    delete process.env.INGEST_LANE_ROUTER
  })

  test('SIGTERM mid-ingest: in-flight completes + acks, no new pickups, resolves drained', async () => {
    // One message available, then an endless supply behind it — if the drain
    // failed to stand the loops down, ingest would be called more than once.
    messageSupply = [fakeMsg(1), fakeMsg(2), fakeMsg(3), fakeMsg(4)]
    ingestMock.mockImplementation(async () => {
      // SIGTERM lands WHILE the first file is being processed.
      rabbitmq._setTermRequestedForTest(true)
      await new Promise((r) => setTimeout(r, 20))
      return { outcome: 'ingested' }
    })

    const res = await rabbitmq._internal.consumeLoop()

    expect(res).toBe('drained')
    expect(ingestMock).toHaveBeenCalledTimes(1) // finished the in-flight one
    expect(acks).toBe(1) // ... and acked it
    expect(nacks).toBe(0)
    expect(channel.close).toHaveBeenCalled()
    expect(connection.close).toHaveBeenCalled()
  })

  test('control: without SIGTERM the loop keeps pulling messages', async () => {
    messageSupply = [fakeMsg(1), fakeMsg(2), fakeMsg(3)]
    let calls = 0
    ingestMock.mockImplementation(async () => {
      calls += 1
      if (calls >= 3) { rabbitmq._setTermRequestedForTest(true) } // end the test loop
      return { outcome: 'ingested' }
    })

    const res = await rabbitmq._internal.consumeLoop()

    expect(res).toBe('drained')
    expect(ingestMock).toHaveBeenCalledTimes(3)
    expect(acks).toBe(3)
  })

  test('a connection drop still throws (reconnect path unchanged)', async () => {
    messageSupply = []
    // Fire the connection 'close' handler after the loop settles into idle.
    connection.on.mockImplementation((event, cb) => {
      if (event === 'close') { setTimeout(cb, 30) }
    })

    await expect(rabbitmq._internal.consumeLoop()).rejects.toThrow('consume loop ended')
  })

  test('connectWithRetry exits 0 after a drain', async () => {
    messageSupply = [fakeMsg(1)]
    ingestMock.mockImplementation(async () => {
      rabbitmq._setTermRequestedForTest(true)
      return { outcome: 'ingested' }
    })
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`)
    })

    await expect(rabbitmq._internal.connectWithRetry()).rejects.toThrow('exit:0')
    exitSpy.mockRestore()
  })
})
