const path = require('path');

function parseUploadFromFileName (name) {
  const fileLocalPath = `${process.env.CACHE_DIRECTORY}${name}`;
  const streamId = path.dirname(name);
  const uploadId = path.basename(name, path.extname(name));
  return { fileLocalPath, streamId, uploadId };
}

module.exports = {
  parseUploadFromFileName
}
