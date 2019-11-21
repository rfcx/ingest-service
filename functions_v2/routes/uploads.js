const moment = require('moment')
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
  const timestamp = req.body.timestamp
  const streamId = req.body.stream

  if (originalFilename === undefined || streamId === undefined || timestamp === undefined) {
    res.status(400).send('Required: filename, stream, timestamp')
    return
  }

  if (!moment(timestamp, moment.ISO_8601).isValid()) {
    res.status(400).send('Invalid format: timestamp')
    return
  }

  // TODO check that the user is authorized to upload (to the given streamId)
  const userId = 'testuserguid'

  const fileExtension = originalFilename.split('.').pop()

  db.generateUpload(streamId, userId, timestamp, originalFilename, fileExtension)
    .then(data => {
      const uploadId = data.id
      const destinationPath = data.path
      const filePath = `${userId}/${originalFilename}`;

      return storage.getSignedUrl(filePath, 'audio/' + fileExtension)
        .then((url) => {
          if (!url) {
            res.status(500).end()
          }
          else {
            res.json({ uploadId, url })
          }
          return;
        });
    })
    .catch(err => {
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

module.exports = router
