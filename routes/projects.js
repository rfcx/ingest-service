const router = require('express').Router()
const { Converter, httpErrorHandler } = require('@rfcx/http-utils')
const projectsService = require('../services/rfcx/projects')

/**
 * @swagger
 *
 * /projects:
 *   get:
 *        summary: Get readable projects
 *        tags:
 *          - projects
  *        parameters:
 *          - name: keyword
 *            description: Filter projects by name
 *            in: query
 *            type: string
 *          - name: limit
 *            description: Maximum number of results to return
 *            in: query
 *            type: int
 *          - name: offset
 *            description: Number of results to skip
 *            in: query
 *            type: int
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
router.route('/').get((req, res) => {
  const idToken = req.headers.authorization
  const converter = new Converter(req.query, {})
  converter.convert('keyword').optional()
  converter.convert('limit').optional()
  converter.convert('offset').optional()
  converter.validate()
    .then(async (params) => {
      const response = await projectsService.query(idToken, params)
      return res
        .header('Total-Items', response.headers['total-items'])
        .json(response.data)
    })
    .catch(httpErrorHandler(req, res, 'Error while getting projects'))
})

module.exports = router
