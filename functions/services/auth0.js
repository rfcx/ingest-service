const axios = require('axios')

let token

async function getToken (idToken) {
  if (!token || !isTokenValid()) {
    await createToken()
  }
  return token
}

function isTokenValid () {
  // if token exists and won't expire in next 10 mins
  return token && token.expires_at - (new Date()).valueOf() > 600000
}

async function createToken () {
  const url = `https://${process.env.AUTHZERO_DOMAIN}/oauth/token`
  const headers = {
    'Content-Type': 'application/json'
  }
  const payload = {
    client_id: process.env.AUTHZERO_CLIENT_ID,
    client_secret: process.env.AUTHZERO_CLIENT_SECRET,
    audience: process.env.AUTHZERO_AUDIENCE,
    grant_type: process.env.AUTHZERO_GRANT_TYPE
  }

  return axios.post(url, payload, { headers })
    .then(response => {
      token = response.data
      token.expires_at = new Date().valueOf() + (token.expires_in * 1000)
      return token
    })
}

module.exports = {
  getToken
}
