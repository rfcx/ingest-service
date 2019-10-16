const express = require('express')
var router = express.Router()

router.use(require('../middleware/cors'))

const db = require('../services/db')
const storage = require('../services/storage')

/**
 * HTTP function that generates a signed URL
 * The signed URL can be used to upload files to Google Cloud Storage (GCS)
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
router.post('/', (req, res) => {
  const originalFilename = req.body.filename
  const streamId = req.body.stream

  if (originalFilename === undefined || streamId === undefined) {
    res.status(400).send('Required: filename, stream')
    return
  }

  // TODO check that the user is authorized to upload (to the given streamId)
  const userId = 'testuserguid'

  const fileExtension = originalFilename.split('.').pop()

  db.generateUpload(streamId, userId, originalFilename, fileExtension).then(data => {
    const uploadId = data.id
    const destinationPath = data.path

    storage.getSignedUrl(destinationPath, 'audio/' + fileExtension).then(url => {
      res.json({ uploadId, url })
    }).catch(err => {
      console.error(err)
      res.status(500).end()
    })
  }).catch(err => {
    console.error(err)
    res.status(500).end()
  })
})

/**
 * HTTP function that checks the status of an upload
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
router.get('/:id', (req, res) => {
  // TODO check that the user owns the upload 

  const id = req.params.id
  db.getUpload(id).then(data => {
    res.json(data)
  }).catch(err => {
    console.error(err)
    res.status(500).end()
  })
})

/**
 * Preflight CORS
 */
function cors (methods) {
  return (req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '3600'
    })
    res.status(204).end()
  }
}
router.options('/', cors('POST'))
router.options('/:id', cors('GET'))

module.exports = router