const db = require(`../services/db/mongo`);

class IngestionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "IngestionError";
    this.status = status ? status : db.status.FAILED;
  }
}

module.exports = {
  IngestionError,
}
