const moment = require('moment')
const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication')
const verifyToken = authentication.verifyToken
const hasRole = authentication.hasRole

router.use(require('../middleware/cors'))

const db = require('../services/db/mongo')

const httpErrorHandler = require('../utils/http-error-handler')

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
