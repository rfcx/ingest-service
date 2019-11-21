const aws = require('aws-sdk');

const config = require('../services/rfcxConfig.json')

aws.config.update({
  accessKeyId: config.s3AccessKey,
  secretAccessKey: config.s3SecretKey,
  region: config.s3Region,
  signatureVersion: 'v4',
});

module.exports = aws;