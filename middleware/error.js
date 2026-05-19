function notFound (req, res, next) {
  const err = new Error('Not Found')
  err.status = 404
  next(err)
}

function exceptionOccurred (err, req, res, next) {
  const status = err.status || 500
  console.error('Express.js error handler', { req: req.guid, url: req.url, status: status, err: err })

  // If the response has already started streaming (e.g. a download
  // route emitted data via `request.get(...).pipe(res)` and then the
  // upstream errored mid-stream), we MUST NOT try to set headers
  // again — `res.status(...).json(...)` would throw a synchronous
  // ERR_HTTP_HEADERS_SENT, escape Express, become an uncaught
  // exception, and crash the process. Delegate to Express's default
  // finalhandler which closes the connection cleanly.
  if (res.headersSent) {
    return next(err)
  }

  res.status(status).json({
    message: err.message,
    error: err
  })
}

module.exports = { notFound, exceptionOccurred }
