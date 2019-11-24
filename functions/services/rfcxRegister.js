const axios = require('axios')
const qs = require('querystring')

const apiHostName = process.env.API_HOST
const accessToken = process.env.TEMP_ACCESS_TOKEN

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
