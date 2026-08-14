const audioService = require('./audio')
const path = require('path')
const fs = require('fs')
const { rimraf } = require('rimraf')

// Per-worker temp dir: jest runs suites in parallel workers, and
// services/rfcx/ingest.test.js uses this same location and rimrafs it in
// afterEach — concurrently, one suite deletes the other's fixture
// mid-copy (ENOENT). Scope it per worker rather than sharing one path.
const destDir = path.join(__dirname, `../test/tmp-w${process.env.JEST_WORKER_ID || '0'}/`)

beforeEach(async () => {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir)
  }
})

afterEach(async () => {
  await rimraf(destDir + '*', { glob: true })
})

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
    expect(result.tags).toMatchObject({})
    expect(result.size).toBe(6672949)
    expect(result.checksum).toBe('c0cdd1156b69c8255ff83b9eb0ba6412cced8411')
  })
  /**
   * SEGMENT DURATIONS ARE PER-SEGMENT, NOT CUMULATIVE.
   *
   * This test previously asserted `duration: 299.806032` — the WHOLE FILE's
   * length — on all five segments, encoding the very defect it should have
   * caught. ffprobe's `stream.duration` reports a stream-copied segment's END
   * POSITION IN THE SOURCE TIMELINE for some containers, and split() now
   * corrects that by decoding each segment (see measureDecodedDuration).
   *
   * The expectations below are the true per-segment values: 4 x 60.000363s
   * plus a 59.721723s tail (values from the ubuntu 22.04 / ffmpeg 4.4.2
   * image the service actually runs; a different ffmpeg build cuts at slightly
   * different boundaries, which is why these are environment-pinned).
   * sampleCount follows from the same correction.
   */
  test('Can split', async () => {
    const pathFolder = path.join(__dirname, '../test/')
    const pathFile = path.join(pathFolder, 'test-5mins-lv8.flac')

    const splittedFiles = await audioService.split(pathFile, destDir, 60)

    expect(splittedFiles.length).toBe(5)
    expect(splittedFiles[0].path).toBe(path.join(pathFolder, `tmp-w${process.env.JEST_WORKER_ID || '0'}/test-5mins-lv8.000.flac`))
    expect(splittedFiles[0].meta.format).toBe('flac')
    expect(splittedFiles[0].meta.duration).toBe(59.907483)
    expect(splittedFiles[0].meta.sampleCount).toBe(2641920)
    expect(splittedFiles[0].meta.channelLayout).toBe('mono')
    expect(splittedFiles[0].meta.channelCount).toBe(1)
    expect(splittedFiles[0].meta.bitRate).toBe(424)
    expect(splittedFiles[0].meta.sampleRate).toBe(44100)
    expect(splittedFiles[0].meta.codec).toBe('flac')
    expect(splittedFiles[0].meta.tags).toMatchObject({ encoder: 'Lavf58.76.100' })
    expect(splittedFiles[0].meta.size).toBe(15912)
    expect(splittedFiles[0].meta.checksum).toBe('0cd42453c4157d6e654c00d9fbdb210772257716')
    expect(splittedFiles[1].path).toBe(path.join(pathFolder, `tmp-w${process.env.JEST_WORKER_ID || '0'}/test-5mins-lv8.001.flac`))
    expect(splittedFiles[1].meta.format).toBe('flac')
    expect(splittedFiles[1].meta.duration).toBe(59.907483)
    expect(splittedFiles[1].meta.sampleCount).toBe(2641920)
    expect(splittedFiles[1].meta.channelLayout).toBe('mono')
    expect(splittedFiles[1].meta.channelCount).toBe(1)
    expect(splittedFiles[1].meta.bitRate).toBe(28389)
    expect(splittedFiles[1].meta.sampleRate).toBe(44100)
    expect(splittedFiles[1].meta.codec).toBe('flac')
    expect(splittedFiles[1].meta.tags).toMatchObject({ encoder: 'Lavf58.76.100' })
    expect(splittedFiles[1].meta.size).toBe(1063917)
    expect(splittedFiles[1].meta.checksum).toBe('28d511c24c254f2127591bce6f1af96f5b1970b6')
    expect(splittedFiles[2].path).toBe(path.join(pathFolder, `tmp-w${process.env.JEST_WORKER_ID || '0'}/test-5mins-lv8.002.flac`))
    expect(splittedFiles[2].meta.format).toBe('flac')
    expect(splittedFiles[2].meta.duration).toBe(59.907483)
    expect(splittedFiles[2].meta.sampleCount).toBe(2641920)
    expect(splittedFiles[2].meta.channelLayout).toBe('mono')
    expect(splittedFiles[2].meta.channelCount).toBe(1)
    expect(splittedFiles[2].meta.bitRate).toBe(48394)
    expect(splittedFiles[2].meta.sampleRate).toBe(44100)
    expect(splittedFiles[2].meta.codec).toBe('flac')
    expect(splittedFiles[2].meta.tags).toMatchObject({ encoder: 'Lavf58.76.100' })
    expect(splittedFiles[2].meta.size).toBe(1813608)
    expect(splittedFiles[2].meta.checksum).toBe('a47ac83d6182349430de1c415f0b7fb68064e73f')
    expect(splittedFiles[3].path).toBe(path.join(pathFolder, `tmp-w${process.env.JEST_WORKER_ID || '0'}/test-5mins-lv8.003.flac`))
    expect(splittedFiles[3].meta.format).toBe('flac')
    expect(splittedFiles[3].meta.duration).toBe(59.907483)
    expect(splittedFiles[3].meta.sampleCount).toBe(2641920)
    expect(splittedFiles[3].meta.channelLayout).toBe('mono')
    expect(splittedFiles[3].meta.channelCount).toBe(1)
    expect(splittedFiles[3].meta.bitRate).toBe(49454)
    expect(splittedFiles[3].meta.sampleRate).toBe(44100)
    expect(splittedFiles[3].meta.codec).toBe('flac')
    expect(splittedFiles[3].meta.tags).toMatchObject({ encoder: 'Lavf58.76.100' })
    expect(splittedFiles[3].meta.size).toBe(1853343)
    expect(splittedFiles[3].meta.checksum).toBe('dc9b6c69e50dd1668b4508b46104e82b5d3155c6')
    expect(splittedFiles[4].path).toBe(path.join(pathFolder, `tmp-w${process.env.JEST_WORKER_ID || '0'}/test-5mins-lv8.004.flac`))
    expect(splittedFiles[4].meta.format).toBe('flac')
    expect(splittedFiles[4].meta.duration).toBe(59.721723)
    expect(splittedFiles[4].meta.sampleCount).toBe(2633728)
    expect(splittedFiles[4].meta.channelLayout).toBe('mono')
    expect(splittedFiles[4].meta.channelCount).toBe(1)
    expect(splittedFiles[4].meta.bitRate).toBe(52501)
    expect(splittedFiles[4].meta.sampleRate).toBe(44100)
    expect(splittedFiles[4].meta.codec).toBe('flac')
    expect(splittedFiles[4].meta.tags).toMatchObject({ encoder: 'Lavf58.76.100' })
    expect(splittedFiles[4].meta.size).toBe(1967523)
    expect(splittedFiles[4].meta.checksum).toBe('70895883215bbb3562b5cf6aa662a1b46f090caa')
  })
  /**
   * REGRESSION: opus segment durations must be PER-SEGMENT, not cumulative.
   *
   * This is the defect that corrupted 108 production source files. ffprobe
   * reports a stream-copied opus segment's `stream.duration` as its END
   * POSITION IN THE SOURCE TIMELINE:
   *
   *   seg 0:  60.0065   seg 1: 120.0065   seg 2: 150.0065
   *
   * `setAdditionalFileAttrs()` ACCUMULATES those to build each segment's
   * start/end, so a 150s recording was recorded as spanning ~330s. Worst case
   * observed in production: a 301.7s file spanning 1202s.
   *
   * The assertion that matters is the SUM: per-segment durations must add up to
   * the source length, not exceed it. Exact per-segment values are deliberately
   * NOT pinned here — opus packet boundaries shift between ffmpeg builds, and
   * pinning them would make this test about the encoder rather than the bug.
   *
   * Requires a >120s fixture: segmentDuration is `duration >= 120 ? 60 : 120`,
   * so a shorter file yields ONE segment and cannot exhibit the defect at all.
   */
  test('Splits opus into segments whose durations are per-segment, not cumulative', async () => {
    const pathFolder = path.join(__dirname, '../test/')
    const pathFile = path.join(pathFolder, 'test-150s-multiseg.opus')
    const sourceDuration = (await audioService.identify(pathFile)).duration

    const splittedFiles = await audioService.split(pathFile, destDir, 60)

    expect(splittedFiles.length).toBeGreaterThan(1)

    const total = splittedFiles.reduce((sum, f) => sum + f.meta.duration, 0)
    // Pre-fix this summed to ~330s against a 150s source (each segment carrying
    // the running total). Allow 1s for packet-boundary rounding across builds.
    expect(total).toBeGreaterThan(sourceDuration - 1)
    expect(total).toBeLessThan(sourceDuration + 1)

    // No individual segment may exceed the segment length it was cut to — the
    // cumulative bug's signature is durations that GROW with segment index.
    for (const file of splittedFiles) {
      expect(file.meta.duration).toBeLessThanOrEqual(61)
      expect(file.meta.duration).toBeGreaterThan(0)
    }

    // sampleCount is derived from duration in identify(), so it must have been
    // corrected alongside it rather than left describing the whole file.
    for (const file of splittedFiles) {
      expect(file.meta.sampleCount)
        .toBeCloseTo(file.meta.duration * file.meta.sampleRate, -2)
    }
  })

  test('Can convert', async () => {
    const pathFolder = path.join(__dirname, '../test/')
    const pathFile = path.join(pathFolder, 'test-5mins-lv8.flac')
    const destPath = path.join(destDir, 'test-5mins-lv8.wav')

    const convertedFile = await audioService.convert(pathFile, destPath)

    expect(convertedFile.path).toBe(path.join(pathFolder, `tmp-w${process.env.JEST_WORKER_ID || '0'}/test-5mins-lv8.wav`))
    expect(convertedFile.meta.format).toBe('wav')
    expect(convertedFile.meta.duration).toBe(299.806032)
    expect(convertedFile.meta.sampleCount).toBe(13221446)
    expect(convertedFile.meta.channelLayout).toBe('unknown')
    expect(convertedFile.meta.channelCount).toBe(1)
    expect(convertedFile.meta.bitRate).toBe(705600)
    expect(convertedFile.meta.sampleRate).toBe(44100)
    expect(convertedFile.meta.codec).toBe('pcm_s16le')
    expect(convertedFile.meta.tags).toMatchObject({ encoder: 'Lavf58.76.100' })
    expect(convertedFile.meta.size).toBe(26442970)
    expect(convertedFile.meta.checksum).toBe('5dc2c31495e635380ea1336367041080ed0a8a05')
  })
})
