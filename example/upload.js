const axios = require('../utils/axios')
const fs = require('fs')

const apiUrl = 'https://us-central1-rfcx-ingest-dev.cloudfunctions.net/api'
// const apiUrl = 'http://localhost:5000/rfcx-ingest-dev/us-central1/api'
// const apiUrl = 'http://localhost:3030' // local address for v2

const args = process.argv.slice(2)
const filePath = args[0] || 'example.mp3'
const filename = '20191010-010101.mp3'
const stream = 'g1smnj4td3kkmfo7kc1i'
const timestamp = '2019-10-10T01:01:01.000Z'

// Part 1: Get signed url

function requestUploadUrl (originalFilename, streamId) {
  // Make a request for a user with a given ID
  return axios.post(apiUrl + '/uploads', { filename: originalFilename, stream: streamId, timestamp })
    .then(function (response) {
      const url = response.data.url
      const uploadId = response.data.uploadId
      return { url, uploadId }
    })
}

// Part 2: Upload

function upload (signedUrl, filePath) {
  const readStream = fs.createReadStream(filePath)
  const fileType = filePath.split('.').splice(-1)[0]
  const options = {
    headers: {
      'Content-Type': 'audio/' + fileType
    }
  }
  return axios.put(signedUrl, readStream, options)
}

// Part 3: Get ingest status

function checkStatus (uploadId) {
  return axios.get(apiUrl + '/uploads/' + uploadId)
    .then(function (response) {
      return response.data
    })
}

// Let's do this...
let uploadId
requestUploadUrl(filename, stream).then((data) => {
  uploadId = data.uploadId
  return upload(data.url, filePath).then(() => {
    console.info('Upload complete')
  })
}).catch((err) => console.error(err))

// and keep checking for the result
console.info('Waiting 10 secs to check the ingest status')
setTimeout(() => {
  checkStatus(uploadId).then(upload => {
    if (upload.status >= 30) {
      console.info('Ingest failed: ' + upload.failureMessage)
    } else if (upload.status >= 20) {
      console.info('Ingest success')
    } else if (upload.status >= 10) {
      console.info('Started ingesting, but not yet finished')
    } else if (upload.status === 0) {
      console.info('Waiting to be ingested')
    }
  }).catch((err) => console.error(err))
}, 10000)
