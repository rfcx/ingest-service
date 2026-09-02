const { matchAxiosErrorToRfcx, ConflictError } = require('./errors')
const { ValidationError, ForbiddenError, EmptyResultError, UnauthorizedError } = require('@rfcx/http-utils')

// Shape of an axios rejection from Core: `err.response.status` + `.data.message`
const axiosErr = (status, message) => {
  const e = new Error(`Request failed with status code ${status}`)
  e.response = { status, data: { message } }
  return e
}

describe('matchAxiosErrorToRfcx', () => {
  test.each([
    [400, ValidationError],
    [401, UnauthorizedError],
    [403, ForbiddenError],
    [404, EmptyResultError]
  ])('maps Core %i to %p (unchanged behaviour)', (status, Cls) => {
    const out = matchAxiosErrorToRfcx(axiosErr(status, 'm'))
    expect(out).toBeInstanceOf(Cls)
    expect(out.message).toBe('m')
  })

  test('maps Core 409 to ConflictError, preserving the message', () => {
    const out = matchAxiosErrorToRfcx(axiosErr(409, 'There is another file with the same timestamp in the stream.'))
    expect(out).toBeInstanceOf(ConflictError)
    expect(out.name).toBe('ConflictError')
    expect(out.message).toBe('There is another file with the same timestamp in the stream.')
  })

  // The regression this guards against: before the 409 case existed, a Core
  // 409 fell to `default: return err` -- the RAW axios error -- which the http
  // handler renders as a 500 with a generic fallback. That would have made a
  // correct Core change strictly WORSE for the user. Prove the raw error is
  // no longer what comes back.
  test('a Core 409 is NOT returned as the raw axios error any more', () => {
    const raw = axiosErr(409, 'collision')
    const out = matchAxiosErrorToRfcx(raw)
    expect(out).not.toBe(raw)
    expect(out.response).toBeUndefined()
  })

  test('unknown statuses still fall through to the raw error (unchanged)', () => {
    const raw = axiosErr(418, 'teapot')
    expect(matchAxiosErrorToRfcx(raw)).toBe(raw)
  })

  test('a non-axios error (no .response) is returned untouched', () => {
    const plain = new Error('boom')
    expect(matchAxiosErrorToRfcx(plain)).toBe(plain)
  })
})
