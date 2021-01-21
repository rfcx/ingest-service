const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const streamService = require('../services/rfcx/streams')
const arbimonService = require('../services/arbimon')
const httpErrorHandler = require('../utils/http-error-handler')

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
router.route('/')
  .get(verifyToken(), hasRole(['appUser', 'rfcxUser']), (req, res) => {
    const idToken = req.headers.authorization
    const defaultErrorMessage = 'Error while getting streams'

    return streamService.query(idToken, { created_by: 'me' })
      .then((response) => {
        if (response && response.status === 200) {
          res
            .header('Total-Items', response.headers['total-items'])
            .json(response.data)
        } else {
          res.status(500).send(defaultErrorMessage)
        }
      })
      .catch(httpErrorHandler(req, res, defaultErrorMessage))
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

/**
 * HTTP function that creates a stream
 */
router.route('/')
  .post(verifyToken(), hasRole(['appUser', 'rfcxUser']), (req, res) => {
    const name = req.body.name
    const latitude = req.body.latitude
    const longitude = req.body.longitude
    const altitude = req.body.altitude
    const description = req.body.description
    const visibility = req.body.visibility // TODO: remove with the next release of Ingest App
    let is_public = req.body.is_public

    if (is_public === undefined) {
      if (visibility === 'private') {
        is_public = false
      } else {
        is_public = true
      }
    }

    const idToken = req.headers.authorization

    if (!name) {
      res.status(400).send('Required: name')
      return
    }

    const defaultErrorMessage = 'Error while creating a stream.'

    return streamService
      .create({ name, latitude, longitude, description, is_public, idToken })
      .then(async (response) => {
        if (response && response.status === 201) {
          if (`${process.env.ARBIMON_ENABLED}` === 'true') {
            const streamData = response.data
            const userProject = await arbimonService.userProject(idToken)
            const arbimonSiteData = {
              project_id: userProject.project_id,
              name,
              external_id: streamData.id,
              lat: latitude,
              lon: longitude,
              alt: altitude || 0
            }
            await arbimonService.createSite(arbimonSiteData, idToken)
          }
          res.json(response.data)
        } else {
          res.status(500).send(defaultErrorMessage)
        }
      })
      .catch(httpErrorHandler(req, res, defaultErrorMessage))
  })

/**
 * HTTP function that updates a stream
 */
function updateEndpoint (req, res) {
  const streamId = req.params.id
  const name = req.body.name
  const latitude = req.body.latitude
  const longitude = req.body.longitude
  const description = req.body.description
  const is_public = req.body.is_public
  const idToken = req.headers.authorization

  const defaultErrorMessage = 'Error while updating the stream.'

  return streamService.update({ streamId, name, latitude, longitude, description, is_public, idToken })
    .then((response) => {
      if (response && response.status === 200) {
        res.json(response.data)
      } else {
        res.status(500).send(defaultErrorMessage)
      }
    })
    .catch(httpErrorHandler(req, res, defaultErrorMessage))
}

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
 * @swagger
 *
 * /streams/{id}:
 *   delete:
 *        summary: Delete a stream (soft-delete)
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
function deleteEndpoint (req, res) {
  const streamId = req.params.id
  const idToken = req.headers.authorization
  const defaultErrorMessage = 'Error while deleting the stream.'

  return streamService
    .remove({ streamId, idToken })
    .then(() => {
      res.sendStatus(204)
    })
    .catch(httpErrorHandler(req, res, defaultErrorMessage))
}

router.route('/:id/move-to-trash').post(verifyToken(), hasRole(['appUser', 'rfcxUser']), deleteEndpoint) // deprecated. TODO: update Ingest App to use DELETE /streams/{id} endpoint
router.route('/:id').delete(verifyToken(), hasRole(['appUser', 'rfcxUser']), deleteEndpoint)

module.exports = router
