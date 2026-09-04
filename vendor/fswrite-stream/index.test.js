// Regression tests for the vendored fswrite-stream (see index.js header).
//
// The defect: nuts-serve hands ONE `request` stream to BOTH fswrite-stream (via
// lru-diskcache) and stream-res. Upstream fswrite-stream piped inside the fs
// 'open' callback; when that callback landed after response data had started
// flowing, request.pipe() emitted 'error' and returned undefined, and
// `undefined.pipe(wstream)` threw inside an fs completion callback with nothing
// on the stack to catch it => uncaughtException => the api pod died
// (runbooks/FINDING-2026-09-04-fswrite-stream-uncaught-crash-class.md in rfcx-local).
//
// The two-consumer cases run OUT OF PROCESS (race-runner.js) against the real
// request@2.60.0 + stream-res, because jest-circus catches uncaughtException
// inside its sandbox and would hide the crash the RED control exists to prove.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { PassThrough } = require('stream')
const EventEmitter = require('events')

const fsWriteStream = require('./index')

const RUNNER = path.join(__dirname, 'race-runner.js')
const ASSET_BYTES = 262144

function runRace (impl, slowOpenMs = 40) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RUNNER, impl, String(slowOpenMs)], { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? err.code : 0,
        stderr: String(stderr),
        result: stdout.trim() ? JSON.parse(stdout.trim().split('\n').pop()) : null
      })
    })
  })
}

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-test-')) })

describe('vendored fswrite-stream', () => {
  test('control: writes a plain stream to disk and reports its size', async () => {
    const target = path.join(tmp, 'control.bin')
    const src = new PassThrough()
    const p = new Promise((resolve, reject) => {
      fsWriteStream(target, src, {}, (err, size) => (err ? reject(err) : resolve(size)))
    })
    src.end(Buffer.alloc(ASSET_BYTES, 0x42))
    await expect(p).resolves.toBe(ASSET_BYTES)
    expect(fs.statSync(target).size).toBe(ASSET_BYTES)
  })

  test('RED control: the upstream shape crashes the process when fs open lands after data flowed', async () => {
    const r = await runRace('upstream')
    expect(r.code).toBe(7)
    expect(r.stderr).toMatch(/UNCAUGHT:Cannot read properties of undefined \(reading 'pipe'\)/)
  })

  test('vendored: same ordering, no crash, both consumers complete with the full asset', async () => {
    for (const slowOpenMs of [10, 40, 120]) {
      const r = await runRace('vendored', slowOpenMs)
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      expect(r.result).toEqual({ cacheErr: null, cacheSize: ASSET_BYTES, fileSize: ASSET_BYTES })
    }
  })

  test('vendored: a source whose pipe() returns undefined settles the callback with an error (no hang)', async () => {
    const silent = { on () { return this }, removeAllListeners () { return this }, pipe () { return undefined } }
    const calls = []
    await new Promise((resolve) => {
      fsWriteStream(path.join(tmp, 'silent.bin'), silent, {}, (err) => { calls.push(err); setTimeout(resolve, 50) })
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeInstanceOf(Error)
    expect(calls[0].message).toMatch(/refused to pipe/)
  })

  test('vendored: a source that emits error synchronously inside pipe() AND returns undefined settles exactly once', async () => {
    const src = new EventEmitter()
    src.pipe = function () { this.emit('error', new Error('cannot pipe')); return undefined }
    const calls = []
    await new Promise((resolve) => {
      fsWriteStream(path.join(tmp, 'double.bin'), src, {}, (err) => { calls.push(err); setTimeout(resolve, 50) })
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].message).toBe('cannot pipe')
  })
})
