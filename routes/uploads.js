const express = require('express')
const router = express.Router()
const { Converter, ValidationError, httpErrorHandler, EmptyResultError, ForbiddenError } = require('@rfcx/http-utils')
const platform = process.env.PLATFORM || 'amazon'
const db = require('../services/db/mongo')
const storage = require(`../services/storage/${platform}`)
const segmentService = require('../services/rfcx/segments')
const streamService = require('../services/rfcx/streams')
const arbimonService = require('../services/rfcx/arbimon')
const auth0Service = require('../services/auth0')
const moment = require('moment-timezone')
const { getSampleRateFromFilename } = require('../services/rfcx/guardian')
const { maxDurationWithGraceSeconds, maxDurationHoursDisplay, flacLimitSize, wavLimitSize, otherLimitSize } = require('../utils/limits')

function getProjectIdFromStream (stream) {
  if (!stream) { return null }
  if (typeof stream.project === 'string') { return stream.project }
  if (typeof stream.project_id === 'string') { return stream.project_id }
  if (typeof stream.projectId === 'string') { return stream.projectId }
  if (stream.project && typeof stream.project.id === 'string') { return stream.project.id }
  return null
}

async function assertProjectUploadWithinLimit (idToken, streamId, durationMs) {
  if (!durationMs || durationMs <= 0) { return null }

  const streamResponse = await streamService.get({ id: streamId, idToken })
  const projectId = getProjectIdFromStream(streamResponse?.data)
  if (!projectId) { return null }

  const summary = await arbimonService.getProjectUploadLimitSummary(idToken, projectId)
  if (summary.isLocked) {
    throw new ValidationError('Project is view-only and cannot accept uploads.')
  }
  if (summary.recordingMinutesLimit === null) {
    return { projectId, summary }
  }

  const pendingDurationMs = await db.getPendingProjectDuration(projectId)
  const totalMinutes = Number(summary.recordingMinutesCount || 0) + ((Number(pendingDurationMs || 0) + durationMs) / 60000)

  if (totalMinutes > Number(summary.recordingMinutesLimit) + 1e-9) {
    throw new ValidationError('Project recording-minute limit exceeded.')
  }

  return { projectId, summary }
}

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
router.route('/').post((req, res) => {
  if (`${process.env.CREATION_PAUSED}` === 'true') {
    return res.status(503).json({ message: 'Server is on maintenance. Creating new uploads is paused. Try again later.' })
  }
  const idToken = req.headers.authorization
  const userId = req.user.guid || req.user.sub || 'unknown'
  const converter = new Converter(req.body, {})
  converter.convert('filename').toString()
  converter.convert('timestamp').toMomentUtc()
  converter.convert('stream').toString()
  converter.convert('duration').optional().minimum(1).toInt()
  converter.convert('fileSize').optional().minimum(1).toInt()
  converter.convert('sampleRate').optional().toInt()
  converter.convert('targetBitrate').optional().toInt()
  converter.convert('checksum').optional().toString()

  converter.validate()
    .then(async (params) => {
      // Cannot upload to the future
      const isFuture = params.timestamp.isAfter(moment.utc())
      if (isFuture) {
        throw new ValidationError(`Future date upload: ${params.timestamp}`)
      }

      // Cannot upload to the past older than year 1971
      const isPast = params.timestamp.year() < 1971
      if (isPast) {
        throw new ValidationError(`Past date upload: ${params.timestamp}`)
      }

      // Cannot upload file that duration more than the configured max (milliseconds)
      const durationLimit = maxDurationWithGraceSeconds * 1000
      if (params.duration && params.duration > durationLimit) {
        throw new ValidationError(`Audio duration is more than ${maxDurationHoursDisplay} hours`)
      }

      // Cannot upload file that size more than the per-extension limit.
      // FLAC may be large (already compressed); WAV/other stay tightly bounded.
      const fileExtension = params.filename.split('.').pop().toLowerCase()
      if (fileExtension === 'flac' && params.fileSize && params.fileSize > flacLimitSize) {
        throw new ValidationError(`This flac file size is exceeding our limit (${flacLimitSize / 1_000_000}MB)`)
      }
      if (fileExtension === 'wav' && params.fileSize && params.fileSize > wavLimitSize) {
        throw new ValidationError(`This wav file size is exceeding our limit (${wavLimitSize / 1_000_000}MB)`)
      }
      // Other file extensions (e.g. opus)
      if (!['flac', 'wav'].includes(fileExtension) && params.fileSize && params.fileSize > otherLimitSize) {
        throw new ValidationError(`This file size is exceeding our limit (${otherLimitSize / 1_000_000}MB)`)
      }
      return params
    })
    .then(async (params) => {
      if (!auth0Service.getRoles(req.user).includes('systemUser')) {
        await streamService.checkPermission('U', params.stream, idToken)
      }
      const uploadProject = await assertProjectUploadWithinLimit(idToken, params.stream, params.duration)
      const fileExtension = params.filename.split('.').pop().toLowerCase()
      let { filename, timestamp, stream, sampleRate, targetBitrate, checksum } = params
      if (params.checksum) {
        try {
          const existingStreamSourceFile = await segmentService.getExistingSourceFile({ stream, timestamp, checksum, idToken })
          const hasSegments = existingStreamSourceFile.segments && existingStreamSourceFile.segments.length
          const sameFile = hasSegments && Math.abs(moment.utc(existingStreamSourceFile.segments[0].start).valueOf() - timestamp.valueOf()) < 1000
          if (!sameFile || (sameFile && existingStreamSourceFile.availability !== 0)) {
            const message = sameFile ? 'Duplicate.' : 'Invalid.'
            throw new ValidationError(message)
          }
        } catch (e) {
          if (e.message !== 'Stream source file not found') {
            throw e
          }
        }
      }
      if (params.filename.endsWith('.opus')) {
        const gSampleRate = getSampleRateFromFilename(params.filename)
        if (gSampleRate) {
          sampleRate = gSampleRate
        }
      }
      const upload = await db.generateUpload({
        streamId: stream,
        userId,
        projectId: uploadProject?.projectId,
        duration: params.duration,
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
    })
    .catch(httpErrorHandler(req, res, 'Failed creating an upload.'))
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
router.route('/:id').get((req, res) => {
  const id = req.params.id
  const userId = req.user.guid || req.user.sub || 'unknown'
  db.getUpload(id)
    .then((data) => {
      if (!data) {
        throw new EmptyResultError('Upload with given id not found.')
      }
      if (data.userId !== userId) {
        throw new ForbiddenError('You do not have permission to access this upload.')
      }
      res.json(data)
    })
    .catch(httpErrorHandler(req, res, 'Failed getting upload with given id.'))
})

module.exports = router
