const moment = require('moment')
const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const platform = process.env.PLATFORM || 'google'
const db = require('../services/db/mongo')
const storage = require(`../services/storage/${platform}`)
const segmentService = require('../services/rfcx/segments')

/**
 * @swagger
 *
 * /uploads:
 *   post:
 *        summary: Generates a signed URL
 *        tags:
 *          - uploads
 *        requestBody:
 *          description: Stream object
 *          required: true
 *          content:
 *            application/x-www-form-urlencoded:
 *              schema:
 *                $ref: '#/components/requestBodies/Uploads'
 *            application/json:
 *              schema:
 *                $ref: '#/components/requestBodies/Uploads'
 *        responses:
 *          200:
 *            description: An upload object
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/Upload'
 *          400:
 *            description: Error while generating upload url
 *          500:
 *            description: Error while generating upload url
 */

/**
 * HTTP function that generates a signed URL
 * The signed URL can be used to upload files to Google Cloud Storage (GCS)
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
router.route('/').post(verifyToken(), hasRole(['appUser', 'rfcxUser', 'systemUser']), async (req, res) => {
  const idToken = req.headers.authorization
  // required params
  const originalFilename = req.body.filename
  const timestamp = req.body.timestamp
  const streamId = req.body.stream
  const checksum = req.body.checksum
  // optional params
  const sampleRate = req.body.sampleRate
  const targetBitrate = req.body.targetBitrate

  console.log(`Upload request | ${streamId} | ${originalFilename} | ${timestamp} | ${checksum}`)

  if (originalFilename === undefined || streamId === undefined || timestamp === undefined || checksum === undefined) {
    res.status(400).send('Required: filename, stream, timestamp, checksum')
    return
  }

  if (!moment(timestamp, moment.ISO_8601).isValid()) {
    res.status(400).send('Invalid format: timestamp')
    return
  }

  const userId = req.user.guid || req.user.sub || 'unknown'
  const fileExtension = originalFilename.split('.').pop().toLowerCase()

  try {
    var existingStreamSourceFiles = await segmentService.getExistingSourceFiles({ streamId, checksum, idToken })
  } catch (e) {
    if (e && e.response && e.response.status) {
      return res.sendStatus(e.response.status)
    }
    return res.sendStatus(500)
  }
  if (existingStreamSourceFiles && existingStreamSourceFiles.length) {
    const sameFile = existingStreamSourceFiles.find(x => x.filename === originalFilename)
    const message = sameFile ? 'This file was already ingested.' : 'Duplicate file. Matching sha1 signature already ingested.'
    return res.status(400).send(message)
  }
  db.generateUpload({ streamId, userId, timestamp, originalFilename, fileExtension, sampleRate, targetBitrate, checksum })
    .then(data => {
      const uploadId = data.id
      return storage.getSignedUrl(data.path, 'audio/' + fileExtension)
        .then((url) => {
          if (!url) {
            res.status(500).end()
          } else {
            res.json({
              uploadId,
              url,
              path: data.path,
              bucket: process.env.UPLOAD_BUCKET
            })
          }
        })
    })
    .catch(err => {
      console.error(err)
      res.sendStatus(500)
    })
})

/**
 * @swagger
 *
 * /uploads/{id}:
 *   get:
 *        summary: Checks the status of an upload
 *        tags:
 *          - uploads
 *        parameters:
 *          - name: id
 *            description: An upload id
 *            in: path
 *            required: true
 *            type: string
 *        responses:
 *          200:
 *            description: Success
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/UploadStatus'
 *          500:
 *            description: Error while getting upload status
 */

/**
 * HTTP function that checks the status of an upload
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
router.route('/:id').get(verifyToken(), hasRole(['appUser', 'rfcxUser']), (req, res) => {
  // TODO check that the user owns the upload

  const id = req.params.id
  db.getUpload(id)
    .then(data => {
      res.json(data)
    })
    .catch(err => {
      console.error(err)
      res.status(500).end()
    })
})

module.exports = router
