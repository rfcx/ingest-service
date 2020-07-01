const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole
const hash = require('../utils/hash');

router.use(require('../middleware/cors'))

const platform = process.env.PLATFORM || 'google'
const db = require(`../services/db/${platform}`)
const rfcx = require('../services/rfcx/register')
const streamService = require('../services/rfcx/streams');
const errors = require('../utils/error-messages')
const httpErrorHandler = require('../utils/http-error-handler')

router.route('/')
  .get(verifyToken(), hasRole(['rfcxUser']), (req, res) => {

    const idToken = req.headers.authorization

    return streamService.getUserStreams(idToken, 'personal-all')
      .then((data) => {
        res.json( data )
      })
      .catch(err => {
        if (err.message === errors.UNAUTHORIZED) {
          res.status(401).send(err.message)
        } else {
          res.status(500).send(err.message)
        }
      })
  })

/**
 * HTTP function that creates a stream
 */
router.route('/')
  .post(verifyToken(), hasRole(['rfcxUser']), (req, res) => {

    const name = req.body.name
    const latitude = req.body.latitude
    const longitude = req.body.longitude
    const description = req.body.description
    const is_private = req.body.is_private

    const idToken = req.headers['authorization'];

    if (!name) {
      res.status(400).send('Required: name')
      return
    }

    const defaultErrorMessage = 'Error while creating a stream.'

    return streamService
      .createStream({ name, latitude, longitude, description, is_private, idToken })
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
  const is_private = req.body.is_private
  const idToken = req.headers['authorization'];

  const defaultErrorMessage = 'Error while updating a stream.'

  return streamService.updateStream({ streamId, name, latitude, longitude, description, is_private, idToken })
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

router.route('/:id').post(verifyToken(), hasRole(['rfcxUser']), updateEndpoint)
router.route('/:id').patch(verifyToken(), hasRole(['rfcxUser']), updateEndpoint)

router.route('/:id/move-to-trash')
  .post(verifyToken(), hasRole(['rfcxUser']), (req, res) => {

    const streamId = req.params.id
    const idToken = req.headers['authorization'];

    return streamService
      .moveStreamToTrash({ streamId, idToken })
      .then(() => {
        res.json({ success: true })
      })
      .catch(err => {
        let message = err.response && err.response.data && err.response.data.message? err.response.data.message : 'Error while moving stream to trash.'
        if (err.response && err.response.data && err.response.data == errors.UNAUTHORIZED) {
          res.status(401).send(message)
        }
        else if (message === `You don't have enough permissions for this action.`) {
          res.status(403).send(message)
        }
        else if (message === `Stream with given guid not found.`) {
          res.status(404).send(message)
        }
        else {
          console.log(err)
          res.status(500).send(message)
        }
      })
  })

router.route('/:id')
  .delete(verifyToken(), hasRole(['rfcxUser']), (req, res) => {

    const streamId = req.params.id
    const idToken = req.headers['authorization'];

    return streamService
      .deleteStream({ streamId, idToken })
      .then(() => {
        res.json({ success: true })
      })
      .catch(err => {
        let message = err.response && err.response.data && err.response.data.message? err.response.data.message : 'Error while deleting a stream.'
        if (err.response && err.response.data && err.response.data == errors.UNAUTHORIZED) {
          res.status(401).send(message)
        }
        else if (message === `You don't have permissions to delete non-empty stream.` ||
                 message === `You don't have enough permissions for this action.`) {
          res.status(403).send(message)
        }
        else if (message === `Stream with given guid not found.`) {
          res.status(404).send(message)
        }
        else {
          console.log(err)
          res.status(500).send(message)
        }
      })
  })

module.exports = router
