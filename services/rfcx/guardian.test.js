const { getSampleRateFromFilename } = require('./guardian')

describe('getSampleRateFromFilename', () => {
  test('should return 24000', () => {
    expect(getSampleRateFromFilename('p0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kHz_90.923secs.opus')).toEqual(24000)
  })
  test('should return 48000', () => {
    expect(getSampleRateFromFilename('47c7pyc0uobq_2021-05-13T00-54-12.981-0530_48kHz_0.923secs.opus')).toEqual(48000)
  })
  test('should return 44100', () => {
    expect(getSampleRateFromFilename('47c7pyc0uobq_2021-05-13T00-54-12.981-0530_44.1kHz_0.923secs.opus')).toEqual(44100)
  })
  test('should return 8000', () => {
    expect(getSampleRateFromFilename('47c7pyc0uobq_2021-05-13T00-54-12.981-0530_8kHz_0.923secs.opus')).toEqual(8000)
  })
  test('should return 4000', () => {
    expect(getSampleRateFromFilename('47c7pyc0uobq_2021-05-13T00-54-12.981-0530_4.kHz_0.923secs.opus')).toEqual(4000)
  })
  test('should return undefined for _kHz_', () => {
    expect(getSampleRateFromFilename('47c7pyc0uobq_2021-05-13T00-54-12.981-0530_kHz_0.923secs.opus')).toBeUndefined()
  })
  test('should return correct result if khz is lowercased', () => {
    expect(getSampleRateFromFilename('47c7pyc0uobq_2021-05-13T00-54-12.981-0530_12khz_0.923secs.opus')).toBe(12000)
  })
  test('should return undefined for an AudioMoth filename', () => {
    expect(getSampleRateFromFilename('20210310_140000.flac')).toBeUndefined()
  })
  test('should return undefined for a random filename', () => {
    expect(getSampleRateFromFilename('some_name.wav')).toBeUndefined()
  })
})
