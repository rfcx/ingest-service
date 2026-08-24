// ---------------------------------------------------------------------------
// Unit tests for the `file_size` -> `fileSize` request-body alias (2026-08-24).
//
// WHY THIS FILE EXISTS SEPARATELY: the equivalent assertion through the HTTP
// route needs a 200 response, and every 200 path in routes/uploads.int.test.js
// requires MongoDB. These are pure-function tests, so the mapping is verifiable
// with no infrastructure -- including the edge cases an HTTP test would not
// reach cheaply (both spellings present, fileSize=0, malformed bodies).
//
// BACKGROUND: the desktop uploader (rfcx/arbimon-uploader utils/api.js) posts
// `file_size`; this API reads `fileSize`. The value was silently dropped, so
// `params.fileSize && params.fileSize > wavLimitSize` short-circuited and the
// size cap never ran -- an oversized file got 200 + a signed URL, then failed
// client-side, leaving the upload row at status 0 forever with no error.
// ---------------------------------------------------------------------------

process.env.PLATFORM = 'amazon'
process.env.UPLOAD_BUCKET = 'streams-uploads'

const { normaliseUploadBody } = require('./uploads')

describe('normaliseUploadBody', () => {
  test('maps file_size -> fileSize when only the snake_case form is present', () => {
    const out = normaliseUploadBody({ filename: 'a.wav', file_size: 518400745 })
    expect(out.fileSize).toBe(518400745)
  })

  test('leaves a camelCase fileSize untouched', () => {
    const out = normaliseUploadBody({ filename: 'a.wav', fileSize: 123 })
    expect(out.fileSize).toBe(123)
  })

  test('camelCase WINS when both are present (the alias cannot mask a real value)', () => {
    const out = normaliseUploadBody({ fileSize: 999, file_size: 1 })
    expect(out.fileSize).toBe(999)
  })

  test('does NOT overwrite an explicit fileSize of 0 (guard is `undefined`, not falsiness)', () => {
    // 0 is independently rejected by .minimum(1); the point is that the alias
    // must not silently replace a value the caller actually sent.
    const out = normaliseUploadBody({ fileSize: 0, file_size: 5000 })
    expect(out.fileSize).toBe(0)
  })

  test('leaves a body with neither key unchanged', () => {
    const body = { filename: 'a.wav', duration: 60000 }
    expect(normaliseUploadBody(body)).toEqual(body)
  })

  test('does not mutate the caller-supplied body', () => {
    const body = { file_size: 42 }
    const out = normaliseUploadBody(body)
    expect(body.fileSize).toBeUndefined()
    expect(out.fileSize).toBe(42)
  })

  test('preserves every other field', () => {
    const out = normaliseUploadBody({
      filename: 'x.wav',
      timestamp: 't',
      stream: 's',
      checksum: 'c',
      duration: 60000,
      sampleRate: 48000,
      file_size: 7
    })
    expect(out).toMatchObject({
      filename: 'x.wav',
      timestamp: 't',
      stream: 's',
      checksum: 'c',
      duration: 60000,
      sampleRate: 48000,
      fileSize: 7
    })
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 7]
  ])('passes through a non-object body (%s) without throwing', (_name, body) => {
    expect(() => normaliseUploadBody(body)).not.toThrow()
    expect(normaliseUploadBody(body)).toBe(body)
  })
})
