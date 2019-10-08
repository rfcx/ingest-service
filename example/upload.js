const filePath = 'example.wav'


// Part 1: Get signed url

const axios = require('axios')

//const apiUrl = 'http://localhost:5000/rfcx-ingest-dev/us-central1/api'
const apiUrl = 'https://us-central1-rfcx-ingest-dev.cloudfunctions.net/api'

function requestUploadUrl () {
  // Make a request for a user with a given ID
  return axios.post(apiUrl + '/uploads')
    .then(function (response) {
      const url = response.data.url
      const uploadId = response.data.uploadId
      console.log('uploadId = ' + uploadId)
      return url
    })
    .catch(function (error) {
      console.log(error)
    })
}



// Part 2: Upload

const fs = require("fs")

function upload (signedUrl, filePath) {
  const readStream = fs.createReadStream(filePath)
  const options = {
    headers: {
      'Content-Type': 'audio/wav'
    }
  }
  return axios.put(signedUrl, readStream, options)
}


// Let's do this!

requestUploadUrl().then((url) => {
  upload(url, filePath).then(() => {
    console.log('Done!')
  }).catch((err) => console.log(err))
})




// Part 3: Get ingest status -- todo!
