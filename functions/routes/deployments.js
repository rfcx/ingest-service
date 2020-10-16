const moment = require('moment')
const express = require('express')
var router = express.Router()

const authentication = require('../middleware/authentication');
const verifyToken = authentication.verifyToken;
const hasRole = authentication.hasRole;

router.use(require('../middleware/cors'))

const db = require(`../services/db/mongo`)

router.route('/').post(verifyToken(), hasRole(['appUser', 'rfcxUser', 'systemUser']), (req, res) => {

  // required params
  const deploymentId = req.body.deploymentId
  const locationName = req.body.locationName
  const latitude = req.body.latitude
  const longitude = req.body.longitude
  const deployedAt = req.body.deployedAt

  console.log(`DeploymentInfo request | ${deploymentId} | ${locationName} | ${latitude} | ${longitude} | ${deployedAt}`)

  if (deploymentId === undefined || locationName === undefined || latitude === undefined || longitude === undefined || deployedAt === undefined) {
    res.status(400).send('Required: deploymentId, locationName, latitude, longitude, deployedAt')
    return
  }

  if (!moment(deployedAt, moment.ISO_8601).isValid()) {
    res.status(400).send('Invalid format: deployedAt')
    return
  }

  db.saveDeploymentInfo({deploymentId, locationName, latitude, longitude, deployedAt})

})

module.exports = router