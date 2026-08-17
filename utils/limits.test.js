const limits = require('./limits')

describe('sizeLimitForExtension', () => {
  test('flac gets the large (already-compressed) cap', () => {
    expect(limits.sizeLimitForExtension('flac')).toBe(limits.flacLimitSize)
  })

  test('wav gets the uncompressed cap', () => {
    expect(limits.sizeLimitForExtension('wav')).toBe(limits.wavLimitSize)
  })

  // AIFF is uncompressed PCM in a different container: byte-for-byte the same
  // size as WAV for the same audio (measured 2026-08-14: 22,050,054 B AIFF vs
  // 22,050,078 B WAV for an identical 125s stereo 44.1kHz signal). If it fell
  // through to the `other` cap it would be rejected at 150 MB while the
  // identical recording is accepted as WAV at 200 MB.
  test.each(['aiff', 'aif'])('%s shares the WAV cap, not the other cap', (ext) => {
    expect(limits.sizeLimitForExtension(ext)).toBe(limits.wavLimitSize)
    expect(limits.sizeLimitForExtension(ext)).not.toBe(limits.otherLimitSize)
  })

  test('opus stays on the other cap', () => {
    expect(limits.sizeLimitForExtension('opus')).toBe(limits.otherLimitSize)
  })

  test('an unknown extension falls back to the other cap', () => {
    expect(limits.sizeLimitForExtension('xyz')).toBe(limits.otherLimitSize)
  })

  test('the uncompressed set is exactly wav + aiff spellings', () => {
    expect([...limits.uncompressedExtensions].sort()).toEqual(['aif', 'aiff', 'wav'])
  })
})
