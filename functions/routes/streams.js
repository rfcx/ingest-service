const express = require('express')
var router = express.Router()

router.use(require('../middleware/cors'))

const db = require('../services/db')

/**
 * HTTP function that creates a stream
 */
router.post('/', (req, res) => {
  const name = req.body.name
  return db.createStream(name).then(result => {
    res.json(result)
  }).catch(err => {
    console.log(err)
    res.status(500).end()
  })
})

module.exports = router