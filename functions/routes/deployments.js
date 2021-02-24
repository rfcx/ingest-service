const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const { httpErrorHandler } = require('@rfcx/http-utils')
const deploymentService = require('../services/deployments')

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
 *            description: A deploymentInfo object
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/DeploymentInfo'
 *          404:
 *            description: DeploymentInfo does not exist
 */
router.route('/:id').get(verifyToken(), hasRole(['appUser', 'rfcxUser', 'systemUser']), async (req, res) => {
  const idToken = req.headers.authorization
  const id = req.params.id
  try {
    const data = await deploymentService.get(id, idToken)
    res.json(data)
  } catch (e) {
    httpErrorHandler(req, res, 'Failed getting deployment info with given id.')(e);
  }
})

module.exports = router
