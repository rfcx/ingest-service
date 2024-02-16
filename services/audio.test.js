const audioService = require('./audio')
const path = require('path')
const fs = require('fs')
const { rimraf } = require('rimraf')

describe('Test audio service', () => {
  test('Can identify', async () => {
    const pathFile = path.join(__dirname, '../test/', 'test-5mins-lv8.flac')

    const result = await audioService.identify(pathFile)

    expect(result.format).toBe('flac')
    expect(result.duration).toBe(299.806032)
    expect(result.sampleCount).toBe(13221446)
    expect(result.channelLayout).toBe('mono')
    expect(result.channelCount).toBe(1)
    expect(result.bitRate).toBe(178060)
    expect(result.sampleRate).toBe(44100)
    expect(result.codec).toBe('flac')
    expect(result.tag).toBeUndefined()
    expect(result.size).toBe(6672949)
    expect(result.checksum).toBe('c0cdd1156b69c8255ff83b9eb0ba6412cced8411')
  })
  test('Can split', async () => {
    const pathFile = path.join(__dirname, '../test/', 'test-5mins-lv8.flac')
    const destDir = path.join(__dirname, '../test/tmp/')
    await rimraf(destDir + '*', { glob: true })

    await audioService.split(pathFile, destDir, 60)

    const splittedFiles = fs.readdirSync(destDir)
    expect(splittedFiles.length).toBe(5)
  })
  test('Can convert', async () => {
    const pathFile = path.join(__dirname, '../test/', 'test-5mins-lv8.flac')
    const destDir = path.join(__dirname, '../test/tmp/')
    const destPath = path.join(destDir, 'test-5mins-lv8.wav')
    await rimraf(destDir + '*', { glob: true })

    await audioService.convert(pathFile, destPath)

    const splittedFiles = fs.readdirSync(destDir)
    expect(splittedFiles.length).toBe(1)
    expect(path.basename(splittedFiles[0])).toBe('test-5mins-lv8.wav')
  })
})
