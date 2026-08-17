const express = require('express')
const router = express.Router()
const { Converter, ValidationError, httpErrorHandler, EmptyResultError, ForbiddenError } = require('@rfcx/http-utils')
const platform = process.env.PLATFORM || 'amazon'
const db = require('../services/db/uploads')
const storage = require(`../services/storage/${platform}`)
const uploadTargets = require('../services/uploads/upload-targets')
const segmentService = require('../services/rfcx/segments')
const streamService = require('../services/rfcx/streams')
const arbimonService = require('../services/rfcx/arbimon')
const auth0Service = require('../services/auth0')
const moment = require('moment-timezone')
const { getSampleRateFromFilename } = require('../services/rfcx/guardian')
const { maxDurationWithGraceSeconds, maxDurationHoursDisplay, flacLimitSize, wavLimitSize, otherLimitSize } = require('../utils/limits')
const { minRecordingYear } = require('../utils/recorder-provenance')

const maxBulkUploadCount = Number(process.env.UPLOAD_BULK_MAX_ITEMS || 100)
// Parallelism for /uploads/bulk registration (2026-08-12 perf fix). Modest
// default: each item still does its own dedup lookup + doc insert + signing,
// and 8 workers on a 100-item batch already collapses ~85s to a few seconds.
const bulkSignConcurrency = Number(process.env.UPLOAD_BULK_SIGN_CONCURRENCY || 8)

function getProjectIdFromStream (stream) {
  if (!stream) { return null }
  if (typeof stream.project === 'string') { return stream.project }
  if (typeof stream.project_id === 'string') { return stream.project_id }
  if (typeof stream.projectId === 'string') { return stream.projectId }
  if (stream.project && typeof stream.project.id === 'string') { return stream.project.id }
  return null
}

/**
 * Bulk-batch registration cache (2026-08-12 — the /uploads/bulk latency fix).
 *
 * A browser batch is typically 100 items for ONE stream, but registerUpload
 * repeated the same three HTTP round trips (permission check, stream→project
 * resolution, project-limit summary) for every item — measured ~850ms/item,
 * so a full batch held "Requesting URL…" for ~85s. The cache memoizes those
 * per-(stream) lookups for the LIFETIME OF ONE REQUEST only; per-item work
 * (dedup by checksum, target selection, doc creation, signing) is untouched.
 *
 * Quota correctness under the parallel loop: batchPendingMs tracks duration
 * ADMITTED in this batch per project and is added to the DB pending figure.
 * Items already created by this batch may ALSO appear in the DB figure —
 * that double-count only over-reserves (conservative at the limit edge),
 * never under-enforces.
 */
function makeBulkRegistrationCache () {
  return {
    permissionByStream: new Map(), // stream -> Promise<void>
    projectByStream: new Map(), // stream -> Promise<{ projectId, summary } | null>
    batchPendingMs: new Map() // projectId -> number
  }
}

async function resolveProjectSummary (idToken, streamId, cache) {
  const fetch = async () => {
    const streamResponse = await streamService.get({ id: streamId, idToken })
    const projectId = getProjectIdFromStream(streamResponse?.data)
    if (!projectId) { return null }
    const summary = await arbimonService.getProjectUploadLimitSummary(idToken, projectId)
    return { projectId, summary }
  }
  if (!cache) { return fetch() }
  let promise = cache.projectByStream.get(streamId)
  if (!promise) {
    promise = fetch()
    cache.projectByStream.set(streamId, promise)
  }
  return promise
}

async function assertProjectUploadWithinLimit (idToken, streamId, durationMs, cache) {
  if (!durationMs || durationMs <= 0) { return null }

  const resolved = await resolveProjectSummary(idToken, streamId, cache)
  if (!resolved) { return null }
  const { projectId, summary } = resolved

  if (summary.isLocked) {
    throw new ValidationError('Project is view-only and cannot accept uploads.')
  }
  if (summary.recordingMinutesLimit === null) {
    return { projectId, summary }
  }

  const pendingDurationMs = await db.getPendingProjectDuration(projectId)
  const batchPendingMs = cache ? (cache.batchPendingMs.get(projectId) || 0) : 0
  const totalMinutes = Number(summary.recordingMinutesCount || 0) + ((Number(pendingDurationMs || 0) + batchPendingMs + durationMs) / 60000)

  if (totalMinutes > Number(summary.recordingMinutesLimit) + 1e-9) {
    throw new ValidationError('Project recording-minute limit exceeded.')
  }
  if (cache) {
    cache.batchPendingMs.set(projectId, batchPendingMs + durationMs)
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

  // Historical recordings ARE permitted (digitised tape/archive material):
  // the storage layer represents them natively and production already holds
  // ~551 genuine pre-1971 segments. What must still be rejected is an UNSET
  // RECORDER CLOCK (a dead battery restarts a digital recorder at the Unix
  // epoch), and that is decided by PROVENANCE, not by the date alone.
  //
  // At sign time we have no file bytes and therefore no recorder tags, so we
  // can only enforce the absurdity floor here. The provenance rule runs at
  // ingest, where ffprobe has read the file's own metadata
  // (services/rfcx/ingest.js -> validateAudioMeta). See
  // utils/recorder-provenance.js for the measurements behind this.
  if (params.timestamp.year() < minRecordingYear) {
    throw new ValidationError(`Past date upload: ${params.timestamp} (before ${minRecordingYear}, which is not a plausible recording date)`)
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

// Shared registration: validation, permission, quota, dedup, target selection
// and the Mongo upload doc. Used by both the single-PUT and multipart flows.
async function registerUpload (rawParams, { req, idToken, userId, bulkCache }) {
  const params = await parseUploadParams(rawParams)

  if (!auth0Service.getRoles(req.user).includes('systemUser')) {
    if (bulkCache) {
      // one permission round trip per (stream) per batch — shared promise
      let permission = bulkCache.permissionByStream.get(params.stream)
      if (!permission) {
        // Promise.resolve: a sync return (or a mock) would store a falsy
        // value and defeat the cache — always store a real promise.
        permission = Promise.resolve(streamService.checkPermission('U', params.stream, idToken))
        bulkCache.permissionByStream.set(params.stream, permission)
      }
      await permission
    } else {
      await streamService.checkPermission('U', params.stream, idToken)
    }
  }
  const uploadProject = await assertProjectUploadWithinLimit(idToken, params.stream, params.duration, bulkCache)
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
  return { upload, params, fileExtension }
}

async function createSignedUpload (rawParams, { req, idToken, userId, bulkCache }) {
  const { upload, fileExtension } = await registerUpload(rawParams, { req, idToken, userId, bulkCache })
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

// ---------------------------------------------------------------------------
// Presigned multipart upload (2026-07-16, browser large-file path).
//
// Part sizing: fixed server-chosen size so the client cannot pick pathological
// values. S3/R2 constraints: parts 5MB..5GB (last part may be smaller), max
// 10,000 parts. With 64MB parts a 1GiB FLAC is 16 parts; well within limits.
// ---------------------------------------------------------------------------
const MULTIPART_PART_SIZE_BYTES = Number(process.env.MULTIPART_PART_SIZE_BYTES || 64 * 1024 * 1024)
const MULTIPART_MIN_FILE_BYTES = Number(process.env.MULTIPART_MIN_FILE_BYTES || 100 * 1024 * 1024)
const MULTIPART_MAX_PARTS = 10000

async function createMultipartSignedUpload (rawParams, { req, idToken, userId }) {
  if (!rawParams || !rawParams.fileSize) {
    throw new ValidationError('fileSize is required for multipart uploads.')
  }
  const fileSize = Number(rawParams.fileSize)
  if (fileSize < MULTIPART_MIN_FILE_BYTES) {
    throw new ValidationError(`Multipart is for files >= ${MULTIPART_MIN_FILE_BYTES / 1_000_000}MB; use POST /uploads for smaller files.`)
  }
  const partCount = Math.ceil(fileSize / MULTIPART_PART_SIZE_BYTES)
  if (partCount > MULTIPART_MAX_PARTS) {
    throw new ValidationError('File is too large for the configured part size.')
  }

  const { upload, fileExtension } = await registerUpload(rawParams, { req, idToken, userId })
  const uploadId = upload.id
  const signingSource = upload.signingSource || upload.uploadSource
  const contentType = 'audio/' + fileExtension

  const multipartUploadId = await storage.createMultipartUpload(upload.path, contentType, signingSource)
  await db.setUploadMultipart(uploadId, { uploadId: multipartUploadId, partSizeBytes: MULTIPART_PART_SIZE_BYTES, partCount })
  const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1)
  const partUrls = await storage.getSignedPartUrls(upload.path, multipartUploadId, partNumbers, signingSource)

  return {
    uploadId,
    multipartUploadId,
    partSizeBytes: MULTIPART_PART_SIZE_BYTES,
    partCount,
    partUrls,
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
 * /uploads/multipart:
 *   post:
 *        summary: Registers a large upload and returns presigned part URLs
 *        description: Same validation/permission/quota/dedup as POST /uploads, but for large files. Returns one presigned PUT URL per part (server-chosen part size). The client PUTs each part (collecting ETags) then calls /uploads/{id}/multipart/complete.
 *        tags:
 *          - uploads
 *        responses:
 *          200:
 *            description: Multipart upload descriptor with per-part signed URLs
 *          400:
 *            description: Invalid parameters (or file too small for multipart)
 *          401:
 *            description: Unauthorized
 *          503:
 *            description: Upload creation is paused
 */
router.route('/multipart').post((req, res) => {
  if (`${process.env.CREATION_PAUSED}` === 'true') {
    return res.status(503).json({ message: 'Server is on maintenance. Creating new uploads is paused. Try again later.' })
  }
  const idToken = req.headers.authorization
  const userId = req.user.guid || req.user.sub || 'unknown'

  createMultipartSignedUpload(req.body, { req, idToken, userId })
    .then((upload) => { res.json(upload) })
    .catch(httpErrorHandler(req, res, 'Failed creating a multipart upload.'))
})

/**
 * @swagger
 *
 * /uploads/{id}/multipart/complete:
 *   post:
 *        summary: Completes a multipart upload
 *        description: Server-side CompleteMultipartUpload with the client-collected part ETags. R2 fires its ObjectCreated event on completion, triggering ingestion exactly like a single PUT.
 *        tags:
 *          - uploads
 *        responses:
 *          200:
 *            description: Completed
 *          400:
 *            description: Invalid parts payload
 *          403:
 *            description: Not the upload owner
 *          404:
 *            description: Unknown upload / no multipart in progress
 */
router.route('/:id/multipart/complete').post((req, res) => {
  const id = req.params.id
  const parts = req.body && req.body.parts
  if (!Array.isArray(parts) || parts.length < 1 || !parts.every(p => p && Number.isInteger(p.partNumber) && typeof p.etag === 'string' && p.etag.length > 0)) {
    return httpErrorHandler(req, res, 'Failed completing multipart upload.')(new ValidationError("Parameter 'parts' must be a non-empty array of { partNumber, etag }."))
  }

  return Promise.resolve().then(async () => {
    const upload = assertUploadStatusAccess(req, await db.getUpload(id))
    if (!upload.multipart || !upload.multipart.uploadId) {
      throw new EmptyResultError('No multipart upload in progress for this upload id.')
    }
    if (upload.multipart.completedAt) {
      // Idempotent: repeated completes (e.g. client retry after a timeout)
      return res.json({ uploadId: id, completed: true })
    }
    // The object key lives on the persisted uploadSource (fetched docs have
    // no top-level `path`); legacy fallback derives it from streamId + id.
    const fallbackKey = `${upload.streamId}/${upload._id}.${(upload.originalFilename || '').split('.').pop().toLowerCase()}`
    const source = uploadTargets.sourceFromUpload(upload, fallbackKey)
    await storage.completeMultipartUpload(source.key || fallbackKey, upload.multipart.uploadId, parts, source)
    await db.setUploadMultipartCompleted(id)
    res.json({ uploadId: id, completed: true })
  }).catch(httpErrorHandler(req, res, 'Failed completing multipart upload.'))
})

/**
 * @swagger
 *
 * /uploads/{id}/multipart/abort:
 *   post:
 *        summary: Aborts a multipart upload and frees its stored parts
 *        tags:
 *          - uploads
 *        responses:
 *          200:
 *            description: Aborted
 *          403:
 *            description: Not the upload owner
 *          404:
 *            description: Unknown upload / no multipart in progress
 */
router.route('/:id/multipart/abort').post((req, res) => {
  const id = req.params.id
  return Promise.resolve().then(async () => {
    const upload = assertUploadStatusAccess(req, await db.getUpload(id))
    if (!upload.multipart || !upload.multipart.uploadId) {
      throw new EmptyResultError('No multipart upload in progress for this upload id.')
    }
    if (upload.multipart.abortedAt || upload.multipart.completedAt) {
      return res.json({ uploadId: id, aborted: Boolean(upload.multipart.abortedAt) })
    }
    const fallbackKey = `${upload.streamId}/${upload._id}.${(upload.originalFilename || '').split('.').pop().toLowerCase()}`
    const source = uploadTargets.sourceFromUpload(upload, fallbackKey)
    await storage.abortMultipartUpload(source.key || fallbackKey, upload.multipart.uploadId, source)
    await db.setUploadMultipartAborted(id)
    res.json({ uploadId: id, aborted: true })
  }).catch(httpErrorHandler(req, res, 'Failed aborting multipart upload.'))
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
    // Bounded-parallel registration with a per-batch lookup cache
    // (2026-08-12): the serial per-item loop repeated the same permission/
    // project/quota round trips 100× — measured ~85s per full batch. Items
    // for the same stream now share those lookups and register concurrently;
    // results keep their request order via index addressing.
    const bulkCache = makeBulkRegistrationCache()
    const results = new Array(uploads.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < uploads.length) {
        const index = cursor++
        try {
          const upload = await createSignedUpload(uploads[index], { req, idToken, userId, bulkCache })
          results[index] = { index, ok: true, ...upload }
        } catch (err) {
          results[index] = {
            index,
            ok: false,
            status: bulkErrorStatus(err),
            error: err.message || 'Failed creating upload.'
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(bulkSignConcurrency, uploads.length) }, worker))

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
