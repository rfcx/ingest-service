const { isPutLimitError, backoffDelayMs, retryOnPutLimit } = require('./put-retry')

// Test-fixture design note (mutation-tested; the standing 08-19 lesson is to
// enumerate where correct/mutated behaviour diverges BEFORE writing fixtures):
//   M1 "retry every error"        -> killed by 'non-throttle error fails fast'
//   M2 "widen the loop bound"     -> EQUIVALENT MUTANT, justified survivor:
//      the `if (attempt === o.attempts) break` line exhausts the sequence
//      before a widened loop condition can matter (removing THAT line is M9,
//      killed). The bound is enforced by the break, not the loop condition.
//   M3 "drop the minMs floor"     -> killed by 'floor engages at negative jitter'
//   M4 "drop the maxMs cap"       -> killed by 'delay pins at cap'
//   M5 "swallow fn's return"      -> killed by 'returns the resolved value'
//   M6 "keep retrying after a non-throttle mid-sequence" -> killed by
//      'throttle then non-throttle throws the second error at attempt 2'
//   M7 "classify on substring of code / any 503" -> killed by the
//      isPutLimitError negative cases
//   M8 "wrap the final error"     -> killed by rejects.toBe(errors[2]) (raw
//      identity matters: ingest.js's catch classifies on the original error)
//   M9 "drop the exhaustion break" -> killed by 'exhausts after exactly N'

function slowDownError () {
  const err = new Error('s3-writer in-flight PUT limit reached; retry')
  err.code = 'SlowDown'
  err.statusCode = 503
  return err
}

const instantSleep = () => Promise.resolve()
const midRng = () => 0.5 // jitter factor (2*0.5-1)=0 => no jitter

describe('isPutLimitError', () => {
  test('true for the aws-sdk parsed SlowDown code', () => {
    expect(isPutLimitError(slowDownError())).toBe(true)
  })
  test('true on the writer message even without a code (mangling proxy/SDK layer)', () => {
    expect(isPutLimitError(new Error('s3-writer in-flight PUT limit reached; retry'))).toBe(true)
  })
  test('message match is case-insensitive', () => {
    expect(isPutLimitError(new Error('S3-WRITER IN-FLIGHT PUT LIMIT REACHED; RETRY'))).toBe(true)
  })
  test('false for other S3 errors, even 503s (M7)', () => {
    const err = new Error('InternalError')
    err.code = 'InternalError'
    err.statusCode = 503
    expect(isPutLimitError(err)).toBe(false)
  })
  test('false for a generic network error (M7)', () => {
    expect(isPutLimitError(new Error('socket hang up'))).toBe(false)
  })
  test('false for null/undefined', () => {
    expect(isPutLimitError(null)).toBe(false)
    expect(isPutLimitError(undefined)).toBe(false)
  })
})

describe('backoffDelayMs', () => {
  const o = { baseMs: 6000, maxMs: 18000, minMs: 5500 }
  test('exponential growth with no jitter: 6s, 12s, then pinned at the 18s cap (M4)', () => {
    expect(backoffDelayMs(1, o, midRng)).toBe(6000)
    expect(backoffDelayMs(2, o, midRng)).toBe(12000)
    expect(backoffDelayMs(3, o, midRng)).toBe(18000)
    expect(backoffDelayMs(4, o, midRng)).toBe(18000)
  })
  test('floor engages at full negative jitter (M3): 6000*0.7=4200 -> clamped to 5500 (> the writer 5s window)', () => {
    expect(backoffDelayMs(1, o, () => 0)).toBe(5500)
  })
  test('positive jitter never exceeds maxMs*(1+jitter)', () => {
    expect(backoffDelayMs(3, o, () => 1)).toBeLessThanOrEqual(18000 * 1.3)
  })
  test('every possible delay exceeds the writer 5s acquire window', () => {
    for (const rng of [() => 0, () => 0.25, midRng, () => 0.75, () => 1]) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect(backoffDelayMs(attempt, o, rng)).toBeGreaterThan(5000)
      }
    }
  })
})

describe('retryOnPutLimit', () => {
  test('returns the resolved value on first-attempt success (M5), no sleeps', async () => {
    const sleep = jest.fn(instantSleep)
    const fn = jest.fn().mockResolvedValue({ ETag: 'abc' })
    const result = await retryOnPutLimit(fn, { attempts: 5, sleep, rng: midRng })
    expect(result).toEqual({ ETag: 'abc' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  test('retries the throttle signal and returns the eventual success value (M5)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(slowDownError())
      .mockRejectedValueOnce(slowDownError())
      .mockResolvedValue({ ETag: 'ok' })
    const onRetry = jest.fn()
    const result = await retryOnPutLimit(fn, { attempts: 5, sleep: instantSleep, rng: midRng, onRetry })
    expect(result).toEqual({ ETag: 'ok' })
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, delayMs: 6000 })
    expect(onRetry.mock.calls[1][0]).toMatchObject({ attempt: 2, delayMs: 12000 })
  })

  test('non-throttle error fails fast on the FIRST attempt (M1)', async () => {
    const err = new Error('Access Denied')
    err.code = 'AccessDenied'
    const fn = jest.fn().mockRejectedValue(err)
    const onRetry = jest.fn()
    await expect(retryOnPutLimit(fn, { attempts: 5, sleep: instantSleep, onRetry })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  test('throttle then non-throttle throws the SECOND error at attempt 2 (M6)', async () => {
    const other = new Error('socket hang up')
    const fn = jest.fn()
      .mockRejectedValueOnce(slowDownError())
      .mockRejectedValueOnce(other)
    await expect(retryOnPutLimit(fn, { attempts: 5, sleep: instantSleep, rng: midRng })).rejects.toBe(other)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('exhausts after exactly N attempts and re-throws the LAST throttle error raw (M2)', async () => {
    const errors = [slowDownError(), slowDownError(), slowDownError()]
    const fn = jest.fn()
      .mockRejectedValueOnce(errors[0])
      .mockRejectedValueOnce(errors[1])
      .mockRejectedValueOnce(errors[2])
    const onRetry = jest.fn()
    const onExhausted = jest.fn()
    await expect(retryOnPutLimit(fn, { attempts: 3, sleep: instantSleep, rng: midRng, onRetry, onExhausted }))
      .rejects.toBe(errors[2])
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2) // no sleep/callback after the final failure
    expect(onExhausted).toHaveBeenCalledTimes(1)
    expect(onExhausted).toHaveBeenCalledWith(errors[2])
  })

  test('attempts=1 means no retry at all: single call, exhausted immediately', async () => {
    const err = slowDownError()
    const fn = jest.fn().mockRejectedValue(err)
    const sleep = jest.fn(instantSleep)
    const onExhausted = jest.fn()
    await expect(retryOnPutLimit(fn, { attempts: 1, sleep, onExhausted })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(onExhausted).toHaveBeenCalledTimes(1)
  })

  test('sleeps with the computed backoff between attempts', async () => {
    const sleep = jest.fn(instantSleep)
    const fn = jest.fn()
      .mockRejectedValueOnce(slowDownError())
      .mockResolvedValue({ ETag: 'ok' })
    await retryOnPutLimit(fn, { attempts: 5, sleep, rng: midRng })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(6000)
  })

  test('env knobs are honoured when opts are not passed', async () => {
    const prev = { ...process.env }
    process.env.PUT_RETRY_ATTEMPTS = '2'
    process.env.PUT_RETRY_BASE_MS = '7000'
    process.env.PUT_RETRY_MAX_MS = '9000'
    process.env.PUT_RETRY_MIN_MS = '6000'
    try {
      const fn = jest.fn().mockRejectedValue(slowDownError())
      const sleep = jest.fn(instantSleep)
      await expect(retryOnPutLimit(fn, { sleep, rng: midRng })).rejects.toBeDefined()
      expect(fn).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledWith(7000)
    } finally {
      process.env = prev
    }
  })
})
