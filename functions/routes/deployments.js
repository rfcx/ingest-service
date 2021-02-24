const moment = require('moment')
const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const db = require('../services/db/mongo')

const httpErrorHandler = require('../utils/http-error-handler')

/**
 * @swagger
 *
 * /deployments/{id}:
 *   get:
 *        summary: Get deployment info by id
 *        description: Search Edge/AudioMoth deployment info by id
 *        tags:
 *          - deployments
 *        parameters:
 *          - name: id
 *            description: A id of deployment
 *            in: path
 *            required: true
 *            type: string
 *        responses:
 *          200:
 *            description: An deploymentInfo object
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/DeploymentInfo'
 *          400:
 *            description: DeploymentInfo does not exist
 */
router.route('/:id').get(verifyToken(), hasRole(['appUser', 'rfcxUser', 'systemUser']), (req, res) => {
  const id = req.params.id
  const defaultErrorMessage = 'Error while getting the deployment info.'
  db.getDeploymentInfo(id)
    .then(data => {
      res.json(data)
    })
    .catch(httpErrorHandler(req, res, defaultErrorMessage))
})

module.exports = router
