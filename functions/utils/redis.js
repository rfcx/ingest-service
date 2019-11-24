const redis = require('redis');
const bluebird = require("bluebird");

bluebird.promisifyAll(redis);

let client = redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
})

client.on('ready', () => {
  console.log('Redis: ready');
});

client.on('connect', () => {
  console.log(`Redis: connected to ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
});

client.on('reconnecting', () => {
  console.log(`Redis: reconnecting to ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
});

client.on('error', (err) => {
  console.log(`Redis: error`, { err });
});

module.exports = client;
