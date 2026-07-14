const express = require('express')
const router = express.Router()
const { Converter, ValidationError, httpErrorHandler, EmptyResultError, ForbiddenError } = require('@rfcx/http-utils')
const platform = process.env.PLATFORM || 'amazon'
const db = require('../services/db/mongo')
const storage = require(`../services/storage/${platform}`)
const uploadTargets = require('../services/uploads/upload-targets')
const segmentService = require('../services/rfcx/segments')
const streamService = require('../services/rfcx/streams')
const arbimonService = require('../services/rfcx/arbimon')
const auth0Service = require('../services/auth0')
const moment = require('moment-timezone')
const { getSampleRateFromFilename } = require('../services/rfcx/guardian')
const { maxDurationWithGraceSeconds, maxDurationHoursDisplay, flacLimitSize, wavLimitSize, otherLimitSize } = require('../utils/limits')

const maxBulkUploadCount = Number(process.env.UPLOAD_BULK_MAX_ITEMS || 100)

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

function uploadConverter (body) {
  const converter = new Converter(body || {}, {})
  converter.convert('filename').toString()
  converter.convert('timestamp').toMomentUtc()
  converter.convert('stream').toString()
  converter.convert('duration').optional().minimum(1).toInt()
  converter.convert('fileSize').optional().minimum(1).toInt()
  converter.convert('sampleRate').optional().toInt()
  converter.convert('targetBitrate').optional().toInt()
  converter.convert('checksum').optional().toString()
  // rfcx-local lane tier (2026-07-14): OPTIONAL requested ingest lane group.
  // express|priority|standard; anything else (or absent) -> standard. The
  // CRITERIA that decide the tier are applied here in the web-service (future);
  // for now we accept a client/service-supplied hint and default to standard.
  converter.convert('laneTier').optional().toString()
  return converter
}

async function validateUploadParams (params) {
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
}

// rfcx-local lane-tier selection (2026-07-14). THE place to implement the
// criteria (express if small file, priority if paid project/tier, etc.). For
// now: honour an explicit `laneTier` on the request; otherwise standard.
// Returns one of express|priority|standard.
const LANE_TIERS = ['express', 'priority', 'standard']
function deriveLaneTier (params, _ctx) {
  const requested = (params && params.laneTier ? String(params.laneTier) : '').toLowerCase()
  if (LANE_TIERS.includes(requested)) { return requested }
  // --- future criteria go here (size/duration/project-tier) ---
  return 'standard'
}

async function parseUploadParams (body) {
  const params = await uploadConverter(body).validate()
  return validateUploadParams(params)
}

async function createSignedUpload (rawParams, { req, idToken, userId }) {
  const params = await parseUploadParams(rawParams)

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
  const uploadTarget = await uploadTargets.selectUploadTarget({
    streamId: stream,
    userId,
    projectId: uploadProject?.projectId,
    duration: params.duration,
    fileExtension,
    timestamp: timestamp.toISOString()
  })
  // rfcx-local lane tier: apply the (future) selection criteria here. For now,
  // honour an explicit request and default to standard. This is the single
  // place to add "express if small", "priority if paid project", etc.
  const laneTier = deriveLaneTier(params, { uploadProject })
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
    checksum,
    uploadTarget,
    laneTier
  })
  const uploadId = upload.id
  const url = await storage.getSignedUrl(upload.path, 'audio/' + fileExtension, upload.signingSource || upload.uploadSource)
  return {
    uploadId,
    url,
    path: upload.path,
    bucket: upload.uploadSource?.bucket || process.env.UPLOAD_BUCKET,
    uploadTargetId: upload.uploadSource?.targetId
  }
}

function bulkErrorStatus (err) {
  if (err instanceof ValidationError) { return 400 }
  if (err instanceof ForbiddenError) { return 403 }
  if (err instanceof EmptyResultError) { return 404 }
  return 500
}

function statusName (statusNumber) {
  return Object.keys(db.status).find((key) => db.status[key] === statusNumber) || 'UNKNOWN'
}

function isTerminalStatus (statusNumber) {
  return [db.status.INGESTED, db.status.FAILED, db.status.DUPLICATE, db.status.CHECKSUM].includes(statusNumber)
}

function isRetryableUpload (upload) {
  if (upload.status === db.status.CHECKSUM) { return true }
  return upload.status === db.status.FAILED && upload.failureMessage === 'Server failed with processing your file. Please try again later.'
}

function nextActionForUpload (upload) {
  switch (upload.status) {
    case db.status.WAITING:
    case db.status.UPLOADED:
      return 'wait'
    case db.status.INGESTED:
      return 'complete'
    case db.status.DUPLICATE:
      return 'ignore_duplicate'
    case db.status.CHECKSUM:
      return 'retry_upload'
    case db.status.FAILED:
      return isRetryableUpload(upload) ? 'retry_upload' : 'review_error'
    default:
      return 'contact_support'
  }
}

function uploadStatusResponse (upload) {
  const ingestionResult = upload.ingestionResult || {}
  return {
    uploadId: `${upload._id}`,
    status: upload.status,
    statusName: statusName(upload.status),
    terminal: isTerminalStatus(upload.status),
    retryable: isRetryableUpload(upload),
    nextAction: nextActionForUpload(upload),
    failureMessage: upload.failureMessage || null,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
    stream: {
      id: upload.streamId,
      projectId: upload.projectId || ingestionResult.projectId,
      siteId: ingestionResult.siteId,
      arbimonProjectId: ingestionResult.arbimonProjectId,
      arbimonSiteId: ingestionResult.arbimonSiteId
    },
    recording: ingestionResult.streamSourceFileId
      ? {
          streamSourceFileId: ingestionResult.streamSourceFileId,
          segments: ingestionResult.segments || [],
          ingestedAt: ingestionResult.ingestedAt
        }
      : undefined
  }
}

function assertUploadStatusAccess (req, upload) {
  if (!upload) {
    throw new EmptyResultError('Upload with given id not found.')
  }
  if (!auth0Service.getRoles(req.user).includes('systemUser')) {
    const userId = req.user.guid || req.user.sub || 'unknown'
    if (upload.userId !== userId) {
      throw new ForbiddenError('You do not have permission to access this upload.')
    }
  }
  return upload
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

  createSignedUpload(req.body, { req, idToken, userId })
    .then((upload) => {
      res.json(upload)
    })
    .catch(httpErrorHandler(req, res, 'Failed creating an upload.'))
})

/**
 * @swagger
 *
 * /uploads/bulk:
 *   post:
 *        summary: Generates signed URLs for multiple audio files
 *        description: Creates one upload document and one object-scoped signed PUT URL per submitted audio file. Item failures are returned inline so valid files can still proceed.
 *        tags:
 *          - uploads
 *        requestBody:
 *          description: Bulk upload request
 *          required: true
 *          content:
 *            application/json:
 *              schema:
 *                $ref: '#/components/requestBodies/UploadsBulk'
 *        responses:
 *          200:
 *            description: Bulk upload result with per-item success or error entries
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/UploadsBulkResponse'
 *          400:
 *            description: Invalid bulk request wrapper
 *          401:
 *            description: Unauthorized
 *          503:
 *            description: Upload creation is paused
 */
router.route('/bulk').post((req, res) => {
  if (`${process.env.CREATION_PAUSED}` === 'true') {
    return res.status(503).json({ message: 'Server is on maintenance. Creating new uploads is paused. Try again later.' })
  }

  const uploads = req.body && req.body.uploads
  if (!Array.isArray(uploads)) {
    return httpErrorHandler(req, res, 'Failed creating bulk uploads.')(new ValidationError("Validation errors: Parameter 'uploads' must be an array."))
  }
  if (uploads.length < 1) {
    return httpErrorHandler(req, res, 'Failed creating bulk uploads.')(new ValidationError('At least one upload is required.'))
  }
  if (uploads.length > maxBulkUploadCount) {
    return httpErrorHandler(req, res, 'Failed creating bulk uploads.')(new ValidationError(`Bulk upload limit exceeded. Maximum ${maxBulkUploadCount} uploads are allowed per request.`))
  }

  const idToken = req.headers.authorization
  const userId = req.user.guid || req.user.sub || 'unknown'

  ;(async () => {
    const results = []
    for (let index = 0; index < uploads.length; index++) {
      try {
        const upload = await createSignedUpload(uploads[index], { req, idToken, userId })
        results.push({ index, ok: true, ...upload })
      } catch (err) {
        results.push({
          index,
          ok: false,
          status: bulkErrorStatus(err),
          error: err.message || 'Failed creating upload.'
        })
      }
    }

    const created = results.filter((result) => result.ok).length
    res.json({
      requested: uploads.length,
      created,
      failed: uploads.length - created,
      uploads: results
    })
  })().catch(httpErrorHandler(req, res, 'Failed creating bulk uploads.'))
})

/**
 * @swagger
 *
 * /uploads/status:
 *   post:
 *        summary: Gets ingestion status for multiple uploads
 *        tags:
 *          - uploads
 *        requestBody:
 *          description: Upload ids to check
 *          required: true
 *          content:
 *            application/json:
 *              schema:
 *                $ref: '#/components/requestBodies/UploadsStatus'
 *        responses:
 *          200:
 *            description: Bulk upload status response
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/UploadsStatusResponse'
 *          400:
 *            description: Invalid parameters
 */
router.route('/status').post((req, res) => {
  const uploadIds = req.body && req.body.uploadIds
  if (!Array.isArray(uploadIds)) {
    return httpErrorHandler(req, res, 'Failed getting upload statuses.')(new ValidationError("Validation errors: Parameter 'uploadIds' must be an array."))
  }
  if (uploadIds.length < 1) {
    return httpErrorHandler(req, res, 'Failed getting upload statuses.')(new ValidationError('At least one upload id is required.'))
  }
  if (uploadIds.length > maxBulkUploadCount) {
    return httpErrorHandler(req, res, 'Failed getting upload statuses.')(new ValidationError(`Bulk upload status limit exceeded. Maximum ${maxBulkUploadCount} upload ids are allowed per request.`))
  }

  return Promise.resolve().then(async () => {
    const results = []
    for (let index = 0; index < uploadIds.length; index++) {
      const uploadId = uploadIds[index]
      try {
        const upload = assertUploadStatusAccess(req, await db.getUpload(uploadId))
        results.push({ index, ok: true, ...uploadStatusResponse(upload) })
      } catch (err) {
        results.push({
          index,
          uploadId,
          ok: false,
          status: bulkErrorStatus(err),
          error: err.message || 'Failed getting upload status.'
        })
      }
    }
    res.json({
      requested: uploadIds.length,
      found: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      uploads: results
    })
  }).catch(httpErrorHandler(req, res, 'Failed getting upload statuses.'))
})

/**
 * @swagger
 *
 * /uploads/{id}/status:
 *   get:
 *        summary: Gets ingestion status for an upload
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
 *            description: Upload status response
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/UploadStatusDetail'
 *          403:
 *            description: Access denied
 *          404:
 *            description: Upload not found
 */
router.route('/:id/status').get((req, res) => {
  const id = req.params.id
  db.getUpload(id)
    .then((data) => {
      const upload = assertUploadStatusAccess(req, data)
      res.json(uploadStatusResponse(upload))
    })
    .catch(httpErrorHandler(req, res, 'Failed getting upload status.'))
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
