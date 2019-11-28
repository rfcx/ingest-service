const axios = require('axios')
const qs = require('querystring')
const errors = require('../utils/errors')

const apiHostName = process.env.API_HOST
const accessToken = process.env.TEMP_ACCESS_TOKEN

async function register (guardianGuid, guardianToken, name, site) {
  const url = apiHostName + 'v1/guardians/register'

  const data = { guid: guardianGuid, token: guardianToken, site_guid: site }
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  return axios.post(url, qs.stringify(data), { headers })
    .then(response => {
      console.log('Successfully created stream')
    }).catch(err => {
      if (err.response && err.response.data && err.response.data.message == 'Site with given guid not found.') {
        throw new Error(errors.SITE_NOT_FOUND)
      }
      if (err.response && err.response.status === 401) {
        throw new Error(errors.UNAUTHORIZED)
      }
      throw err
    })
}

module.exports = { register }
