function notFound (req, res, next) {
  const err = new Error('Not Found')
  err.status = 404
  next(err)
}

function exceptionOccurred (err, req, res, next) {
  const status = err.status || 500
  console.error('Express.js error handler', { req: req.guid, url: req.url, status: status, err: err })
  res.status(status).json({
    message: err.message,
    error: err
  })
}

module.exports = { notFound, exceptionOccurred }
