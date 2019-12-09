module.exports = (method) => {
  if (method === 'stream') {
    return require('../ingestStream')
  } else if (method === 'manual') {
    return require('./legacy/ingestManual')
  } else {
    return require('./legacy/ingestCheckin')
  }
}