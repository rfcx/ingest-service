const moment = require('moment')
const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication');
const verifyToken = authentication.verifyToken;
const hasRole = authentication.hasRole;

router.use(require('../middleware/cors'))

const platform = process.env.PLATFORM || 'google';
const db = require(`../services/db/${platform}`)
const storage = require(`../services/storage/${platform}`);

/**
 * HTTP function that generates a signed URL
 * The signed URL can be used to upload files to Google Cloud Storage (GCS)
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
router.route('/').post(verifyToken(), hasRole(['rfcxUser', 'systemUser']), (req, res) => {

  // required params
  const originalFilename = req.body.filename
  const timestamp = req.body.timestamp
  const streamId = req.body.stream
  // optional params
  const sampleRate = req.body.sampleRate;
  const targetBitrate = req.body.targetBitrate;
  // TODO: make checksum required param when Ingest App will send it
  const checksum = req.body.checksum;

  if (originalFilename === undefined || streamId === undefined || timestamp === undefined) {
    res.status(400).send('Required: filename, stream, timestamp')
    return
  }

  if (!moment(timestamp, moment.ISO_8601).isValid()) {
    res.status(400).send('Invalid format: timestamp')
    return
  }

  // TODO check that the user is authorized to upload (to the given streamId)
  let userId = req.user.guid || req.user.sub || 'unknown';

  const fileExtension = originalFilename.split('.').pop().toLowerCase()

  db.generateUpload({ streamId, userId, timestamp, originalFilename, fileExtension, sampleRate, targetBitrate, checksum })
    .then(data => {
      const uploadId = data.id
      return storage.getSignedUrl(data.path, 'audio/' + fileExtension)
        .then((url) => {
          if (!url) {
            res.status(500).end()
          }
          else {
            res.json({ uploadId, url, path: data.path })
          }
          return
        })
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
router.route('/:id').get(verifyToken(), hasRole(['rfcxUser']), (req, res) => {
  // TODO check that the user owns the upload

  const id = req.params.id
  db.getUpload(id)
    .then(data => {
      res.json(data);
    })
    .catch(err => {
      console.error(err)
      res.status(500).end()
    });
})

module.exports = router
