const router = require('express').Router()
const db = require('../services/db/mongo')

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
 *            description: Successful health check
 *          500:
 *            description: Failed health check
 */
router.route('/').get((req, res) => {
  db.getOrCreateHealthCheck()
    .then(() => {
      res.sendStatus(200)
    })
    .catch(() => {
      res.sendStatus(500)
    })
})

module.exports = router
