const axios = require('axios')
const errors = require('../utils/errors')

const apiHostName = process.env.API_HOST

async function touchapi (idToken) {

  const url = `${apiHostName}v1/users/touchapi`
  const headers = {
    'Authorization': idToken,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  return axios.get(url, { headers })
    .then(response => {
      return response.data
    })
    .catch(err => {
      if (err.response && err.response.status === 401) {
        throw new Error(errors.UNAUTHORIZED)
      }
      throw err
    })
}

async function getUserSites (idToken) {

  const url = `${apiHostName}v1/sites?filter_by_user=true`
  const headers = {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  return axios.get(url, { headers })
    .then(response => {
      return response.data
    })
    .catch(err => {
      if (err.response && err.response.status === 401) {
        throw new Error(errors.UNAUTHORIZED)
      }
      throw err
    })

}

async function sendCode (code, idToken) {

  const url = `${apiHostName}v1/users/code`
  const data = { code: code }
  const headers = {
    'Authorization': idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
    .then(response => {
      return response.data
    })
    .catch(err => {
      if (err.response && err.response.status === 401) {
        throw new Error(errors.UNAUTHORIZED)
      }
      throw new Error(errors.INVALID_CODE)
    })
}

module.exports = {
  touchapi,
  sendCode,
  getUserSites,
}
