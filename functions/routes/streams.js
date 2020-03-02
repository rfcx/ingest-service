const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const platform = process.env.PLATFORM || 'google'
const db = require(`../services/db/${platform}`)
const rfcx = require('../services/rfcx/register')
const streamService = require('../services/rfcx/streams');
const errors = require('../utils/errors')

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
router.route('/legacy')
  .post(verifyToken(), hasRole(['rfcxUser']), (req, res) => {
    const name = req.body.name
    const site = req.body.site

    if (name === undefined) {
      res.status(400).send('Required: name')
      return
    }
    const idToken = req.headers.authorization
    return db.createStream(name)
      .then(result => {
        return rfcx.register(result.id, result.token, name, site, idToken)
          .then(() => {
            res.json({ id: result.id })
          });
      })
      .catch(err => {
        if (err.message === errors.SITE_NOT_FOUND) {
          res.status(400).send(err.message)
        } else if (err.message === errors.UNAUTHORIZED) {
          res.status(401).send(err.message)
        } else {
          console.log(err)
          res.status(500).send(err.message)
        }
      })
  })

/**
 * HTTP function that creates a stream
 * v2 is temporary until we migrate to new client app
 */
router.route('/')
  .post(verifyToken(), hasRole(['rfcxUser']), (req, res) => {

    const name = req.body.name
    const site = req.body.site
    const visibility = req.body.visibility || 'private';
    const idToken = req.headers['authorization'];

    if (!name) {
      res.status(400).send('Required: name')
      return
    }
    if (!site) {
      res.status(400).send('Required: site')
      return
    }

    return db.createStream(name)
      .then(result => {
        const streamId = result.id;
        return streamService
          .createStream({ streamId, name, site, visibility, idToken })
          .then(() => {
            res.json({ id: result.id })
          })
      })
      .catch(err => {
        let message = err.response && err.response.data && err.response.data.message? err.response.data.message : 'Error while creating a stream.'
        if (message === 'Site with given guid not found.') {
          res.status(400).send(message)
        }
        else if (message == errors.UNAUTHORIZED) {
          res.status(401).send(message)
        }
        else if (message === `You are not allowed to add a stream with the site ${site}`) {
          res.status(403).send(message)
        }
        else {
          console.log(err)
          res.status(500).send(message)
        }
      })
  })

/**
 * HTTP function that edits a stream (e.g. rename)
 */
router.route('/:id')
  .post(verifyToken(), hasRole(['rfcxUser']), (req, res) => {
    const id = req.params.id
    const name = req.body.name
    const site = req.body.site

    if (name === undefined) {
      res.status(400).send('Required: name')
      return
    }

    return db.editStream(id, name, site).then(result => {
      // TODO rfcx.editStream(..)
      res.json({})
    }).catch(err => {
      if (err.message === errors.UNAUTHORIZED) {
        res.status(401).send(err.message)
      } else {
        console.log(err)
        res.status(500).send(err.message)
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
        return db.deleteStream(streamId)
      })
      .then(() => {
        res.json({ success: true })
      })
      .catch(err => {
        let message = err.response && err.response.data && err.response.data.message? err.response.data.message : 'Error while deleting a stream.'
        if (message == errors.UNAUTHORIZED) {
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
