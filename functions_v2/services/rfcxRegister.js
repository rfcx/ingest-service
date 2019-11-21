const axios = require('axios')
const qs = require('querystring')

const config = require('./rfcxConfig.json')
const apiHostName = config.apiHostName
const accessToken = config.tempAccessToken

async function register (guardianGuid, guardianToken, name) {
  const url = apiHostName + 'v1/guardians/register'

  const data = { guid: guardianGuid, token: guardianToken, shortname: name }
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  return axios.post(url, qs.stringify(data), { headers })
    .then(function (response) {
      console.log('request success')
      console.log(response.data)
    })
}

module.exports = { register }
