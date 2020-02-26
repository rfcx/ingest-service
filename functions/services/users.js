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

async function sendCode (opts, idToken) {

  const url = `${apiHostName}v1/users/code`
  const data = { code: opts.code }
  if (opts.acceptTerms !== undefined) {
    data.accept_terms = !!opts.acceptTerms
  }
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

async function acceptTerms (idToken) {

  const url = `${apiHostName}v1/users/accept-terms`
  const headers = {
    'Authorization': idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, {}, { headers })
    .then(response => {
      return response.data
    })
    .catch(err => {
      if (err.response && err.response.status === 401) {
        throw new Error(errors.UNAUTHORIZED)
      }
      throw new Error('Unable to apply acceptance.')
    })
}

module.exports = {
  touchapi,
  sendCode,
  getUserSites,
  acceptTerms,
}
