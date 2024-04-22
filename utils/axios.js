const axios = require('axios')
const http = require('http')
const https = require('https')

const httpAgent = new http.Agent({ keepAlive: false })
const httpsAgent = new https.Agent({ keepAlive: false })

const instance = axios.create({
  httpAgent,
  httpsAgent
})

module.exports = instance
