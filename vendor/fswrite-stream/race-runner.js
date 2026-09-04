// Child-process runner for index.test.js — reproduces nuts-serve's two-consumer
// shape (backend.js serveAsset: ONE `request` stream handed to BOTH the disk
// cache writer and stream-res) against the REAL request@2.60.0 + stream-res that
// ship in the image, with fs.open slowed so the fs 'open' callback lands after
// response data has started flowing.
//
//   node race-runner.js upstream|vendored [slowOpenMs]
//
// Exit 0 + a JSON line on stdout when both consumers settle; exit 7 with
// `UNCAUGHT:<message>` on stderr if the process would have died in production
// (utils/process-handlers.js exits on uncaughtException). Runs out-of-process
// because jest-circus intercepts uncaughtException inside its sandbox, which
// would hide the very failure the RED control is there to prove.
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { PassThrough } = require('stream')
const request = require('request')
const streamRes = require('stream-res')
const lengthStream = require('length-stream')

const impl = process.argv[2]
const slowOpenMs = parseInt(process.argv[3] || '40', 10)
const ASSET_BYTES = 262144 // 16 chunks x 10 ms = ~160 ms transfer, so the held-back open (below) lands MID-stream

// The upstream fswrite-stream@1.0.0 body, verbatim, so the RED control is the
// real thing and not a caricature.
function upstreamWriteStream (filename, rstream, opts, callback) {
  if (!callback) { callback = opts; opts = {} }
  let size = 0
  const wstream = fs.createWriteStream(filename, opts)
  const lstream = lengthStream(function (length) { size = length })
  function cleanup () { lstream.removeAllListeners(); wstream.removeAllListeners(); rstream.removeAllListeners() }
  function onError (err) { cleanup(); callback(err) }
  lstream.on('error', onError); wstream.on('error', onError); rstream.on('error', onError)
  wstream.on('open', function () { rstream.pipe(lstream).pipe(wstream) })
  wstream.on('finish', function () { cleanup(); callback(null, size) })
}

const writeImpl = impl === 'upstream' ? upstreamWriteStream : require('./index')

process.on('uncaughtException', (e) => {
  process.stderr.write('UNCAUGHT:' + e.message + '\n')
  process.exit(7)
})

// The fs 'open' callback is held until the FIRST response byte has flowed to the
// other consumer, then a further slowOpenMs — i.e. the ordering is forced, not
// left to a wall-clock race (a fixed timer flaked ~1 in 15 under jest load when
// the connect took longer than the delay and the open landed BEFORE any data).
let resolveDataFlowed
const dataFlowed = new Promise((resolve) => { resolveDataFlowed = resolve })
const origOpen = fs.open
fs.open = function (...args) {
  const cb = args[args.length - 1]
  if (typeof cb === 'function') {
    args[args.length - 1] = function (...r) { dataFlowed.then(() => setTimeout(() => cb.apply(this, r), slowOpenMs)) }
  }
  return origOpen.apply(fs, args)
}

const origin = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(ASSET_BYTES) })
  const buf = Buffer.alloc(16384, 0x41)
  let n = 0
  const t = setInterval(() => {
    if (n >= ASSET_BYTES / 16384) { clearInterval(t); res.end(); return }
    res.write(buf); n++
  }, 10)
})

origin.listen(0, '127.0.0.1', () => {
  const port = origin.address().port
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-race-')), 'asset.bin')
  const rstream = request({ uri: `http://127.0.0.1:${port}/asset.nupkg`, method: 'get' })
  rstream.once('data', () => resolveDataFlowed())
  const result = { cacheErr: null, cacheSize: null, fileSize: null }
  let pending = 2
  function done () {
    if (--pending !== 0) { return }
    result.fileSize = fs.existsSync(target) ? fs.statSync(target).size : -1
    process.stdout.write(JSON.stringify(result) + '\n', () => {
      // request's keep-alive socket can outlive the transfer; do not wait on server.close()
      origin.closeAllConnections()
      origin.close()
      process.exit(0)
    })
  }
  const res = new PassThrough()
  res.headers = {}
  res.setHeader = () => {}
  res.headersSent = false
  res.resume()

  // consumer 1: the disk-cache writer (pipes late in upstream, at call time in vendored)
  writeImpl(target, rstream, {}, (err, size) => { result.cacheErr = err ? err.message : null; result.cacheSize = size; done() })
  // consumer 2: stream-res (pipes immediately)
  streamRes(res, rstream, () => done())
})

setTimeout(() => { process.stderr.write('TIMEOUT\n'); process.exit(3) }, 5000).unref()
