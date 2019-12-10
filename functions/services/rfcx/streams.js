const axios = require('axios')

const apiHostName = process.env.API_HOST

async function createStream (opts) {

  const url = `${apiHostName}v2/streams`;
  const data = {
    guid: opts.streamId,
    name: opts.name,
  }
  if (opts.site) {
    data.site = opts.site;
  }

  const headers = {
    'Authorization': opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

module.exports = {
  createStream,
}
