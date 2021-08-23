const { parseGuardianAudioFilename } = require('./guardian')

describe('parseGuardianAudioFilename', () => {
  test('should return correct data for valid guardian filename', () => {
    const data = parseGuardianAudioFilename('p0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kHz_90.923secs.opus')
    expect(data.streamId).toEqual('p0gccfokn3p9')
    expect(data.timestamp.toISOString()).toEqual('2015-01-01T00:04:10.261Z')
    expect(data.sampleRate).toEqual(24000)
    expect(data.duration).toEqual(90.923)
  })
  test('should return correct data for another valid guardian filename', () => {
    const data = parseGuardianAudioFilename('47c7pyc0uobq_2021-05-13T00-54-12.981-0530_48kHz_0.923secs.opus')
    expect(data.streamId).toEqual('47c7pyc0uobq')
    expect(data.timestamp.toISOString()).toEqual('2021-05-13T06:24:12.981Z')
    expect(data.sampleRate).toEqual(48000)
    expect(data.duration).toEqual(0.923)
  })
  test('should return undefined if filename is cutted at start', () => {
    const data = parseGuardianAudioFilename('0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kHz_90.923secs.opus')
    expect(data.streamId).toBeUndefined()
    expect(data.timestamp).toBeUndefined()
    expect(data.sampleRate).toBeUndefined()
    expect(data.duration).toBeUndefined()
  })
  test('should return undefined for an AudioMoth filename', () => {
    const data = parseGuardianAudioFilename('20210310_140000.flac')
    expect(data.streamId).toBeUndefined()
    expect(data.timestamp).toBeUndefined()
    expect(data.sampleRate).toBeUndefined()
    expect(data.duration).toBeUndefined()
  })
  test('should return undefined for a random filename', () => {
    const data = parseGuardianAudioFilename('some_name.wav')
    expect(data.streamId).toBeUndefined()
    expect(data.timestamp).toBeUndefined()
    expect(data.sampleRate).toBeUndefined()
    expect(data.duration).toBeUndefined()
  })
})
