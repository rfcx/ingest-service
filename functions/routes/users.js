const express = require('express')
const router = express.Router()
const userService = require('../services/users')
const errors = require('../utils/errors')

const authentication = require('../middleware/authentication');
const verifyToken = authentication.verifyToken;

router.use(require('../middleware/cors'))

/**
 * HTTP function which forwards request to API
 */
router.route('/touchapi')
  .get(verifyToken(), (req, res) => {

    const idToken = req.headers['authorization'];

    return userService.touchapi(idToken)
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

router.route('/sites')
  .get(verifyToken(), (req, res) => {

    const idToken = req.headers['authorization'];

    return userService.getUserSites(idToken)
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
 * HTTP function which forwards request to API
 */
router.route('/code')
  .post(verifyToken(), (req, res) => {

    const code = req.body.code;
    const acceptTerms = req.body.accept_terms;
    const idToken = req.headers['authorization'];

    return userService.sendCode({ code, acceptTerms }, idToken)
      .then((data) => {
        res.json( data )
      })
      .catch(err => {
        if (err.message === errors.UNAUTHORIZED) {
          res.status(401).send(err.message)
        } else if (err.message === errors.INVALID_CODE) {
          res.status(400).send(err.message)
        } else {
          res.status(500).send(err.message)
        }
      })

  })

router.route('/accept-terms')
  .post(verifyToken(), (req, res) => {

    const idToken = req.headers['authorization'];

    return userService.acceptTerms(idToken)
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

module.exports = router

