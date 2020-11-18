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
 * /deployments:
 *   post:
 *        summary: Add deployment info
 *        description: Save Edge/AudioMoth deployment info
 *        tags:
 *          - deployments
 *        requestBody:
 *          description: Stream object
 *          required: true
 *          content:
 *            application/x-www-form-urlencoded:
 *              schema:
 *                $ref: '#/components/requestBodies/DeploymentInfo'
 *            application/json:
 *              schema:
 *                $ref: '#/components/requestBodies/DeploymentInfo'
 *        responses:
 *          200:
 *            description: An deploymentInfo object
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/DeploymentInfo'
 *          400:
 *            description: Invalid query parameters
 */
router.route('/').post(verifyToken(), hasRole(['systemUser']), (req, res) => {
  // required params
  const deploymentId = req.body.deploymentId
  const locationName = req.body.locationName
  const latitude = req.body.latitude
  const longitude = req.body.longitude
  const deployedAt = req.body.deployedAt
  // optional params
  const groupName = req.body.groupName
  const groupColor = req.body.groupColor

  const defaultErrorMessage = 'Error while saving the deployment info.'

  console.log(`DeploymentInfo request | ${deploymentId} | ${locationName} | ${latitude} | ${longitude} | ${deployedAt} | ${groupName} | ${groupColor}`)

  if (deploymentId === undefined || locationName === undefined || latitude === undefined || longitude === undefined || deployedAt === undefined) {
    res.status(400).send('Required: deploymentId, locationName, latitude, longitude, deployedAt')
    return
  }

  if (!moment(deployedAt, moment.ISO_8601).isValid()) {
    res.status(400).send('Invalid format: deployedAt')
    return
  }

  db.saveDeploymentInfo({ deploymentId, locationName, latitude, longitude, deployedAt, groupName, groupColor })
    .then((data) => {
      res.json(data)
    })
    .catch(httpErrorHandler(req, res, defaultErrorMessage))
})

/**
 * @swagger
 * 
 * /deployments/{id}:
 *   post:
 *        summary: Update deployment info by id
 *        description: Update Edge/AudioMoth deployment info by id
 *        tags:
 *          - deployments
 *        parameters:
 *          - name: id
 *            description: A deployment id
 *            in: path
 *            required: true
 *            type: string
 *        requestBody:
 *          description: Stream object
 *          required: true
 *          content:
 *            application/x-www-form-urlencoded:
 *              schema:
 *                $ref: '#/components/requestBodies/DeploymentInfoUpdate'
 *            application/json:
 *              schema:
 *                $ref: '#/components/requestBodies/DeploymentInfoUpdate'
 *        responses:
 *          200:
 *            description: An deploymentInfo object
 *            content:
 *              application/json:
 *                schema:
 *                   $ref: '#/components/schemas/DeploymentInfo'
 *          400:
 *            description: Invalid query parameters
 */
router.route('/:id').post(verifyToken(), hasRole(['systemUser']), (req, res) => {
  // required params
  const deploymentId = req.params.id
  const locationName = req.body.locationName
  const latitude = req.body.latitude
  const longitude = req.body.longitude
  const deployedAt = req.body.deployedAt
  // optional params
  const groupName = req.body.groupName
  const groupColor = req.body.groupColor

  const defaultErrorMessage = 'Error while updating the deployment info.'

  console.log(`DeploymentInfo request | ${deploymentId} | ${locationName} | ${latitude} | ${longitude} | ${deployedAt} | ${groupName} | ${groupColor}`)

  if (deploymentId === undefined || locationName === undefined || latitude === undefined || longitude === undefined || deployedAt === undefined) {
    res.status(400).send('Required: deploymentId, locationName, latitude, longitude, deployedAt')
    return
  }

  if (!moment(deployedAt, moment.ISO_8601).isValid()) {
    res.status(400).send('Invalid format: deployedAt')
    return
  }

  db.updateDeploymentInfo({ deploymentId, locationName, latitude, longitude, deployedAt, groupName, groupColor })
    .then((data) => {
      res.json(data)
    })
    .catch(httpErrorHandler(req, res, defaultErrorMessage))
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
