const mongoose = require('mongoose');

const mongoUri = `mongodb://${process.env.MONGO_HOSTNAME}/${process.env.MONGO_DB}`;

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function() {
  console.log('Connected to MongoDB');
});

console.log('Establishing connection to MongoDB')
mongoose.connect(mongoUri, {
  user: process.env.MONGO_USERNAME,
  pass: process.env.MONGO_PASSWORD,
  useNewUrlParser: true,
  useUnifiedTopology: true,
  keepAlive: true,
  keepAliveInitialDelay: 300000,
  serverSelectionTimeoutMS: 30000
});

module.exports = db;
