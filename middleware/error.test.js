const { exceptionOccurred, notFound } = require('./error')

function mockReq (overrides = {}) {
  return Object.assign({ guid: 'r-123', url: '/test' }, overrides)
}

function mockRes (overrides = {}) {
  const res = {
    statusCode: 200,
    headersSent: false,
    _jsonBody: undefined,
    status (code) { this.statusCode = code; return this },
    json (body) { this._jsonBody = body; return this }
  }
  return Object.assign(res, overrides)
}

describe('middleware/error', () => {
  let consoleErrorSpy

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  describe('notFound', () => {
    test('produces a 404 error and forwards via next', () => {
      const next = jest.fn()
      notFound(mockReq(), mockRes(), next)
      expect(next).toHaveBeenCalledTimes(1)
      const err = next.mock.calls[0][0]
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toBe('Not Found')
      expect(err.status).toBe(404)
    })
  })

  describe('exceptionOccurred', () => {
    test('sends a JSON error response when headers have not been sent', () => {
      const res = mockRes()
      const next = jest.fn()
      const err = new Error('boom')

      exceptionOccurred(err, mockReq(), res, next)

      expect(res.statusCode).toBe(500)
      expect(res._jsonBody).toEqual({ message: 'boom', error: err })
      expect(next).not.toHaveBeenCalled()
    })

    test('honors err.status', () => {
      const res = mockRes()
      const err = Object.assign(new Error('nope'), { status: 422 })

      exceptionOccurred(err, mockReq(), res, jest.fn())

      expect(res.statusCode).toBe(422)
    })

    test('does NOT throw or set headers when res.headersSent is true; delegates to next', () => {
      // Simulate the Squirrel-update / nuts-serve scenario: a download
      // route already piped bytes to the client (so headersSent=true),
      // then upstream errored. The error middleware must not try to
      // set headers again — that would synchronously throw
      // ERR_HTTP_HEADERS_SENT and crash the process.
      const res = mockRes({
        headersSent: true,
        status () { throw new Error('ERR_HTTP_HEADERS_SENT: should not be called') },
        json () { throw new Error('ERR_HTTP_HEADERS_SENT: should not be called') }
      })
      const next = jest.fn()
      const err = new Error('upstream pipe failed')

      expect(() => exceptionOccurred(err, mockReq(), res, next)).not.toThrow()
      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith(err)
    })
  })
})
