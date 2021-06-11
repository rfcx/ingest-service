const router = require('express').Router()
const mongoose = require('../utils/mongo')

/**
 * @swagger
 *
 * /health-check:
 *   get:
 *        summary: Check health
 *        description: Check health
 *        tags:
 *          - health-check
 *        responses:
 *          200:
 *            description: A value of health check
 *            content:
 *              text/plain:
 *                example: health_check{backend="mongo"} 1
 */
router.route('/').get((req, res) => {
  const mongoMetricStatus = mongoose && mongoose.readyState === 1 ? 1 : 0
  res.type('text/plain').send(`health_check{backend="mongo"} ${mongoMetricStatus}`)
})

module.exports = router
