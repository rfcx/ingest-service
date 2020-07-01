function httpErrorHandler (req, res, defaultMessage) {
  return (err) => {
    console.log('httpErrorHandler', err)
    let message = defaultMessage
    let statusCode = 500
    try {
      message = err.response.data.message
    }
    catch (e) { }
    if (err.response) { // The request was made and the server responded with a status code
      let apiStatusCode = err.response.status
      if ([400, 401, 403].includes(apiStatusCode)) {
        statusCode = apiStatusCode
      }
      if (apiStatusCode === 400) {
        message = 'Invalid data provided.'
      }
    }
    res.status(statusCode).send(message)
  }
}

module.exports = httpErrorHandler
