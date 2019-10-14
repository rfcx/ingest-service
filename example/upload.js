const axios = require('axios')
const fs = require("fs")

const apiUrl = 'https://us-central1-rfcx-ingest-dev.cloudfunctions.net/api'
//const apiUrl = 'http://localhost:5000/rfcx-ingest-dev/us-central1/api'

const filePath = 'example.wav'


// Part 1: Get signed url

function requestUploadUrl (originalFilename, streamId) {
  // Make a request for a user with a given ID
  return axios.post(apiUrl + '/uploads', { filename: originalFilename, stream: streamId })
    .then(function (response) {
      const url = response.data.url
      const uploadId = response.data.uploadId
      return { url, uploadId }
    })
}


// Part 2: Upload

function upload (signedUrl, filePath) {
  const readStream = fs.createReadStream(filePath)
  const options = {
    headers: {
      'Content-Type': 'audio/wav'
    }
  }
  return axios.put(signedUrl, readStream, options)
}


// Part 3: Get ingest status -- todo!

function checkStatus (uploadId) {
  return axios.get(apiUrl + '/uploads/' + uploadId)
    .then(function (response) {
      const status = response.data.status
      return status
    })
}


// Let's do this...
var uploadId
requestUploadUrl('20191010-010101.wav', 'test').then((data) => {
  uploadId = data.uploadId
  return upload(data.url, filePath).then(() => {
    console.log('Done!')
  })
}).catch((err) => console.log(err))

// and keep checking for the result
setTimeout(() => {
  checkStatus(uploadId).then((status) => {
    console.log('Ingest status = ' + status)
  }).catch((err) => console.log(err))
}, 10000)
