const moment = require('moment')
const express = require('express')
const { Converter, ValidationError, httpErrorHandler } = require('@rfcx/http-utils');
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
 *            description: Invalid parameters
 *          401:
 *            description: Unauthorized
 *          403:
 *            description: Access denied for selected stream
 *          404:
 *            description: Stream not found
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
  const converter = new Converter(req.body, {});
  converter.convert('filename').toString();
  converter.convert('timestamp').toMomentUtc();
  converter.convert('stream').toString();
  converter.convert('sampleRate').optional().toInt();
  converter.convert('targetBitrate').optional().toInt();
  converter.convert('checksum').optional().toString();

  try {
    const params = await converter.validate()
    const userId = req.user.guid || req.user.sub || 'unknown'
    const fileExtension = params.filename.split('.').pop().toLowerCase()
    const { filename, timestamp, stream, sampleRate, targetBitrate, checksum } = params
    if (params.checksum) {
      const existingStreamSourceFiles = await segmentService.getExistingSourceFiles({ stream, checksum, idToken })
      if (existingStreamSourceFiles && existingStreamSourceFiles.length) {
        const sameFile = existingStreamSourceFiles.find(x => x.filename === filename)
        const message = sameFile ? 'Duplicate' : 'Invalid.'
        throw new ValidationError(message)
      }
    }
    const upload = await db.generateUpload({
      streamId: stream,
      userId,
      timestamp: timestamp.toISOString(),
      originalFilename: filename,
      fileExtension,
      sampleRate,
      targetBitrate,
      checksum
    })
    const uploadId = upload.id
    const url = await storage.getSignedUrl(upload.path, 'audio/' + fileExtension)
    res.json({
      uploadId,
      url,
      path: upload.path,
      bucket: process.env.UPLOAD_BUCKET
    })
  } catch (e) {
    httpErrorHandler(req, res, 'Failed creating an upload')(e);
  }
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
