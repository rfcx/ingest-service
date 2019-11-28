const express = require('express')
var router = express.Router()

router.use(require('../middleware/cors'))

const platform = process.env.PLATFORM || 'google';
const db = require(`../services/db/${platform}`)
const rfcx = require('../services/rfcxRegister')
const errors = require('../utils/errors')

/**
 * HTTP function that creates a stream
 */
router.post('/', (req, res) => {
  const name = req.body.name
  const site = req.body.site

  if (name === undefined) {
    res.status(400).send('Required: name')
    return
  }

  return db.createStream(name).then(result => {
    return rfcx.register(result.id, result.token, name, site).then(() => {
      res.json({ id: result.id })
    })
  }).catch(err => {
    if (err.message == errors.SITE_NOT_FOUND) {
      res.status(400).send(err.message)
    } else if (err.message == errors.UNAUTHORIZED) {
      res.status(401).send(err.message)
    } else {
      console.log(err)
      res.status(500).send(err.message)
    }
  })
})

module.exports = router
