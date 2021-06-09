const router = require('express').Router()
const { Converter, httpErrorHandler } = require('@rfcx/http-utils')
const streamService = require('../services/rfcx/streams')

/**
 * @swagger
 *
 * /streams:
 *   get:
 *        summary: Get all of streams
 *        tags:
 *          - streams
 *        parameters:
 *          - name: keyword
 *            description: Filter streams by name
 *            in: query
 *            type: string
 *          - name: projects
 *            description: Filter streams by projects
 *            in: query
 *            type: array
 *          - name: permission
 *            description: Return streams for which you have selected permission
 *            in: query
 *            schema:
 *              type: string
 *              enum:
 *                - "R"
 *                - "U"
 *                - "D"
 *            default: ["R"]
 *          - name: limit
 *            description: Maximum number of results to return
 *            in: query
 *            type: int
 *            default: 100
 *          - name: offset
 *            description: Number of results to skip
 *            in: query
 *            type: int
 *            default: 0
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
router.route('/').get((req, res) => {
  const idToken = req.headers.authorization
  const converter = new Converter(req.query, {})
  converter.convert('keyword').optional()
  converter.convert('limit').optional().toInt()
  converter.convert('offset').optional().toInt()
  converter.convert('projects').optional().toArray()
  converter.convert('permission').default('R').toString().isEqualToAny(['R', 'U', 'D'])
  converter.validate()
    .then(async (params) => {
      const response = await streamService.query(idToken, params)
      return res
        .header('Total-Items', response.headers['total-items'])
        .json(response.data)
    })
    .catch(httpErrorHandler(req, res, 'Error while getting streams'))
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
router.route('/').post((req, res) => {
  const idToken = req.headers.authorization
  const converter = new Converter(req.body, {})
  converter.convert('name').toString()
  converter.convert('latitude').toFloat().minimum(-90).maximum(90)
  converter.convert('longitude').toFloat().minimum(-180).maximum(180)
  converter.convert('altitude').optional().toFloat()
  converter.convert('description').optional().toString()
  converter.convert('is_public').optional().toBoolean().default(false)
  converter.convert('project_id').optional().toString()
  converter.validate()
    .then(async (params) => {
      const response = await streamService.create({ ...params, idToken })
      const id = streamService.parseIdFromHeaders(response.headers)
      const streamData = await streamService.get({ id, idToken })
      res.json(streamData.data)
    })
    .catch(httpErrorHandler(req, res, 'Error while creating a stream.'))
})

/**
 * HTTP function that updates a stream
 */
function updateEndpoint (req, res) {
  const idToken = req.headers.authorization
  const streamId = req.params.id
  const converter = new Converter(req.body, {})
  converter.convert('name').optional().toString()
  converter.convert('latitude').optional().toFloat().minimum(-90).maximum(90)
  converter.convert('longitude').optional().toFloat().minimum(-180).maximum(180)
  converter.convert('altitude').optional().toFloat()
  converter.convert('description').optional().toString()
  converter.convert('is_public').optional().toBoolean()

  converter.validate()
    .then(async (params) => {
      const response = await streamService.update({ ...params, streamId, idToken })
      res.json(response.data)
    })
    .catch(httpErrorHandler(req, res, 'Error while updating the stream.'))
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
router.route('/:id').post(updateEndpoint)

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
router.route('/:id').patch(updateEndpoint)

/**
 * HTTP function that deletes a stream
 */
function deleteEndpoint (req, res) {
  const streamId = req.params.id
  const idToken = req.headers.authorization
  streamService.remove({ streamId, idToken })
    .then(() => {
      res.sendStatus(204)
    })
    .catch(httpErrorHandler(req, res, 'Error while deleting the stream.'))
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
router.route('/:id/move-to-trash').post(deleteEndpoint)

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
router.route('/:id').delete(deleteEndpoint)

module.exports = router
