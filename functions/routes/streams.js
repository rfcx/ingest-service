const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const streamService = require('../services/rfcx/streams')

const { Converter, httpErrorHandler } = require('@rfcx/http-utils')

/**
 * @swagger
 *
 * /streams:
 *   get:
 *        summary: Get all of streams
 *        tags:
 *          - streams
 *        responses:
 *          200:
 *            description: List of streams objects
 *            headers:
 *              Total-Items:
 *                schema:
 *                  type: integer
 *                description: Total number of items without limit and offset.
 *            content:
 *              application/json:
 *                schema:
 *                  type: array
 *                  items:
 *                    $ref: '#/components/schemas/StreamWithPermissions'
 *          400:
 *            description: Error while getting streams
 *          500:
 *            description: Error while getting streams
 */
router.route('/').get(verifyToken(), hasRole(['appUser', 'rfcxUser']), async (req, res) => {
  const idToken = req.headers.authorization
  try {
    const response = await streamService.query(idToken, { created_by: 'me' })
    return res
      .header('Total-Items', response.headers['total-items'])
      .json(response.data)
  } catch (e) {
    httpErrorHandler(req, res, 'Error while getting streams')(e);
  }
})

/**
 * @swagger
 *
 * /streams:
 *   post:
 *        summary: Add new stream
 *        tags:
 *          - streams
 *        requestBody:
 *          description: Stream object
 *          required: true
 *          content:
 *            application/x-www-form-urlencoded:
 *              schema:
 *                $ref: '#/components/requestBodies/Stream'
 *            application/json:
 *              schema:
 *                $ref: '#/components/requestBodies/Stream'
 *        responses:
 *          200:
 *            description: Created
 *            content:
 *              application/json:
 *                schema:
 *                  $ref: '#/components/schemas/Stream'
 *          400:
 *            description: Error while creating a stream.
 *          500:
 *            description: Error while creating a stream.
 */
router.route('/').post(verifyToken(), hasRole(['appUser', 'rfcxUser']), async (req, res) => {
  const idToken = req.headers.authorization
  const converter = new Converter(req.body, {});
  converter.convert('name').toString()
  converter.convert('latitude').toFloat().minimum(-90).maximum(90)
  converter.convert('longitude').toFloat().minimum(-180).maximum(180)
  converter.convert('altitude').optional().toFloat()
  converter.convert('description').optional().toString()
  converter.convert('is_public').optional().toBoolean().default(false)
  try {
    const params = await converter.validate()
    const response = await streamService.create({ ...params, idToken })
    const streamData = response.data
    res.json(streamData)
  } catch (e) {
    httpErrorHandler(req, res, 'Error while creating a stream.')(e);
  }
})

/**
 * HTTP function that updates a stream
 */
async function updateEndpoint (req, res) {
  const idToken = req.headers.authorization
  const streamId = req.params.id
  const converter = new Converter(req.body, {});
  converter.convert('name').optional().toString()
  converter.convert('latitude').optional().toFloat().minimum(-90).maximum(90)
  converter.convert('longitude').optional().toFloat().minimum(-180).maximum(180)
  converter.convert('altitude').optional().toFloat()
  converter.convert('description').optional().toString()
  converter.convert('is_public').optional().toBoolean()

  try {
    const params = await converter.validate()
    const response = await streamService.update({ ...params, streamId, idToken })
    res.json(response.data)
  } catch (e) {
    httpErrorHandler(req, res, 'Error while updating the stream.')(e);
  }
}

/**
 * @swagger
 *
 * /streams/{id}:
 *   post:
 *        summary: DEPRECATED
 *        tags:
 *          - streams
 */
router.route('/:id').post(verifyToken(), hasRole(['appUser', 'rfcxUser']), updateEndpoint)

/**
 * @swagger
 *
 * /streams/{id}:
 *   patch:
 *        summary: Update stream by id
 *        tags:
 *          - streams
 *        parameters:
 *          - name: id
 *            description: A stream id
 *            in: path
 *            required: true
 *            type: string
 *        requestBody:
 *          description: Stream object
 *          required: true
 *          content:
 *            application/x-www-form-urlencoded:
 *              schema:
 *                $ref: '#/components/requestBodies/StreamPatch'
 *            application/json:
 *              schema:
 *                $ref: '#/components/requestBodies/StreamPatch'
 *        responses:
 *          200:
 *            description: Success
 *            content:
 *              application/json:
 *                schema:
 *                  $ref: '#/components/schemas/Stream'
 *          400:
 *            description: Error while updating the stream.
 *          500:
 *            description: Error while updating the stream.
 */
router.route('/:id').patch(verifyToken(), hasRole(['appUser', 'rfcxUser']), updateEndpoint)

/**
 * HTTP function that deletes a stream
 */
async function deleteEndpoint (req, res) {
  const streamId = req.params.id
  const idToken = req.headers.authorization
  try {
    await streamService.remove({ streamId, idToken })
    res.sendStatus(204)
  } catch (e) {
    httpErrorHandler(req, res, 'Error while deleting the stream.')(e);
  }
}

/**
 * @swagger
 *
 * /streams/{id}/move-to-trash:
 *   delete:
 *        summary: DEPRECATED
 *        tags:
 *          - streams
 */
router.route('/:id/move-to-trash').post(verifyToken(), hasRole(['appUser', 'rfcxUser']), deleteEndpoint)

/**
 * @swagger
 *
 * /streams/{id}:
 *   delete:
 *        summary: Delete a stream
 *        tags:
 *          - streams
 *        parameters:
 *          - name: id
 *            description: A stream id
 *            in: path
 *            required: true
 *            type: string
 *        responses:
 *          204:
 *            description: Success
 *          400:
 *            description: Error while deleting the stream.
 */
router.route('/:id').delete(verifyToken(), hasRole(['appUser', 'rfcxUser']), deleteEndpoint)

module.exports = router
