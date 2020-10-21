const express = require('express')
var router = express.Router()
const mongoose = require(`../utils/mongo`)

router.route('/').get((req, res) => {
  const mongoMetricStatus = mongoose && mongoose.readyState === 1 ? 1 : 0
  res.type('text/plain').send(`health_check{backend="mongo"} ${mongoMetricStatus}`)
})

module.exports = router
