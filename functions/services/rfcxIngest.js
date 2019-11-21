module.exports = (method) => {
  if (method === 'stream') {
    return require('./rfcxIngestStream')
  } else if (method === 'manual') {
    return require('./rfcxIngestManual')
  } else {
    return require('./rfcxIngestCheckin')
  }
}