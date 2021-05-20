const express = require('express')
const { Converter, httpErrorHandler } = require('@rfcx/http-utils')
const { verifyToken } = require('../middleware/authentication')
const projectsService = require('../services/rfcx/projects')

const router = express.Router()
router.use(require('../middleware/cors'))

/**
 * @swagger
 *
 * /projects:
 *   get:
 *        summary: Get readable projects
 *        tags:
 *          - projects
 *        responses:
 *          200:
 *            description: List of project objects
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
 *                    $ref: '#/components/schemas/Project'
 */
router.route('/').get(verifyToken(), (req, res) => {
  const idToken = req.headers.authorization
  const converter = new Converter(req.query, {})
  converter.convert('keyword').optional()
  converter.convert('limit').optional()
  converter.convert('offset').optional()

  converter.validate().then(async (params) => {
    const response = await projectsService.query(idToken, params)
    return res
      .header('Total-Items', response.headers['total-items'])
      .json(response.data)
  }).catch(httpErrorHandler(req, res, 'Error while getting projects'))
  // projectsService.query(idToken, req.opts).then((response) => {
  //   res.header('Total-Items', response.headers['total-items']).json(response.data)
  // }).catch(httpErrorHandler(req, res, 'Error getting projects'))
})

module.exports = router
