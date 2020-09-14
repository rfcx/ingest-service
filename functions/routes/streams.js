const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const streamService = require('../services/rfcx/streams');
const httpErrorHandler = require('../utils/http-error-handler')

router.route('/')
  .get(verifyToken(), hasRole(['appUser', 'rfcxUser']), (req, res) => {

    const idToken = req.headers.authorization
    const defaultErrorMessage = 'Error while getting streams'

    return streamService.query(idToken, { created_by: 'me' })
      .then((response) => {
        if (response && response.status === 200) {
          const total = parseInt(response.headers['total-items']) || 0
          const streams = (response.data || []).map((x) => {
            x.guid = x.id;
            return x
          });
          res
            .header('Total-Items', response.headers['total-items'])
            .json({ total, streams }) // TODO: change format for next release of the Ingest App
        }
        else {
          res.status(500).send(defaultErrorMessage)
        }
      })
      .catch(httpErrorHandler(req, res, defaultErrorMessage))
  })

/**
 * HTTP function that creates a stream
 */
router.route('/')
  .post(verifyToken(), hasRole(['appUser', 'rfcxUser']), (req, res) => {

    const name = req.body.name
    const latitude = req.body.latitude
    const longitude = req.body.longitude
    const description = req.body.description
    const visibility = req.body.visibility // TODO: remove with the next release of Ingest App
    let is_public = req.body.is_public

    if (is_public === undefined) {
      if (visibility === 'private') {
        is_public = false
      }
      else {
        is_public = true
      }
    }

    const idToken = req.headers['authorization'];

    if (!name) {
      res.status(400).send('Required: name')
      return
    }

    const defaultErrorMessage = 'Error while creating a stream.'

    return streamService
      .create({ name, latitude, longitude, description, is_public, idToken })
      .then((response) => {
        if (response && response.status === 201) {
          res.json(response.data)
        }
        else {
          res.status(500).send(defaultErrorMessage)
        }
      })
      .catch(httpErrorHandler(req, res, defaultErrorMessage))
  })

/**
 * HTTP function that updates a stream
 */
function updateEndpoint(req, res) {
  const streamId = req.params.id;
  const name = req.body.name;
  const latitude = req.body.latitude
  const longitude = req.body.longitude
  const description = req.body.description
  const is_public = req.body.is_public
  const idToken = req.headers['authorization'];

  const defaultErrorMessage = 'Error while updating the stream.'

  return streamService.update({ streamId, name, latitude, longitude, description, is_public, idToken })
    .then((response) => {
      if (response && response.status === 200) {
        res.json(response.data)
      }
      else {
        res.status(500).send(defaultErrorMessage)
      }
    })
    .catch(httpErrorHandler(req, res, defaultErrorMessage))
}

router.route('/:id').post(verifyToken(), hasRole(['appUser', 'rfcxUser']), updateEndpoint)
router.route('/:id').patch(verifyToken(), hasRole(['appUser', 'rfcxUser']), updateEndpoint)

function deleteEndpoint(req, res) {
  const streamId = req.params.id
  const idToken = req.headers['authorization'];
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
