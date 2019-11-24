const express = require('express')
var router = express.Router()

router.use(require('../middleware/cors'))

const platform = process.env.PLATFORM || 'google';
const db = require(`../services/db/${platform}`)
const rfcx = require('../services/rfcxRegister')

/**
 * HTTP function that creates a stream
 */
router.post('/', (req, res) => {
  const name = req.body.name

  if (name === undefined) {
    res.status(400).send('Required: name')
    return
  }

  return db.createStream(name).then(result => {
    return rfcx.register(result.id, result.token, name).then(() => {
      res.json({ id: result.id })
    })
  }).catch(err => {
    if (err.response && err.response.status === 401) {
      res.status(500).send('Unauthorized (access token expired?)')
    } else {
      console.log(err)
      res.status(500).end()
    }
  })
})

module.exports = router
