const probe = require('ffmpeg-probe')

/* Run sox (or in this case ffmpeg) to get the sample rate and duration
** results looks like:
** { format: 'wav', duration: 1.5, sampleCount: 66150, channelCount: 1, bitRate: 722944, sampleRate: 44100 }
*/
function identify (filePath) {
  return probe(filePath).then(result => {
    const stream = result.streams[0]
    const format = result.format.format_name
    const duration = stream.duration
    const sampleCount = stream.duration_ts
    const channelCount = stream.channels
    const bitRate = stream.bit_rate
    const sampleRate = stream.sample_rate
    const codec = stream.codec_name // unused (but contains useful info like 'pcm_s16le')
    return { format, duration, sampleCount, channelCount, bitRate, sampleRate } // , codec }
  })
}

/**
 *
 * @param {String} sourceFile - path to source file on disk
 * @param {Object[]} splittedFiles - array with objects with segments information (local path, duration, start, end timestamps)
 */
function split(sourceFile, splittedFiles) {
  // TODO: write split code here
  // Assume that you have a new file at `/tmp/ingest-service/source`. Just place it there and work with it.
  // Put splitted files into `/tmp/ingest-service/splitted/`
}

module.exports = { identify }
