const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const { Converter, httpErrorHandler } = require('@rfcx/http-utils')
const deploymentService = require('../services/deployments')

/**
 * @swagger
 *
 * /deployments:
 *   get:
 *        summary: Get list of deployments
 *        description: Search Edge/AudioMoth deployments
 *        tags:
 *          - deployments
 *        parameters:
 *          - name: active
 *            description: Get active or inactive deployments
 *            in: query
 *            type: boolean
 *          - name: limit
 *            description: Maximum number of results to return
 *            in: query
 *            type: int
 *            default: 100
 *          - name: offset
 *            description: Number of results to skip
 *            in: query
 *            type: int
 *            default: 0
 *        responses:
 *          200:
 *            description: List of deployments objects
 *            headers:
 *              Total-Items:
 *                schema:
 *                  type: integer
 *                description: Total number of items without limit and offset.
 *            content:
 *              application/json:
 *                schema:
 *                  type: array
 *                  items:
 *                    $ref: '#/components/schemas/DeploymentInfo'
 *          400:
 *            description: Error while getting deployments
 *          500:
 *            description: Error while getting deployments
 */
router.route('/').get(verifyToken(), hasRole(['appUser', 'rfcxUser', 'systemUser']), async (req, res) => {
  try {
    const converter = new Converter(req.query, {});
    converter.convert('active').optional().toBoolean()
    converter.convert('limit').optional().toNonNegativeInt().default(100)
    converter.convert('offset').optional().toNonNegativeInt().default(0)
    const params = await converter.validate()
    const idToken = req.headers.authorization
    const data = await deploymentService.query(params, idToken)
    res.json(data)
  } catch (e) {
    httpErrorHandler(req, res, 'Failed getting deployments.')(e);
  }
})

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
