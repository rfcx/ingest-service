const ffmpeg = require('fluent-ffmpeg')
const path = require('path')

/**
 * Probe an audio file to find its sample rate, duration and other meta data
 * - result: { format: 'wav', duration: 1.5, sampleCount: 66150, channelCount: 1, bitRate: 722944, sampleRate: 44100 }
 * @param {String} sourceFile - path to source file on disk
 * @returns {Promise<Object>} - an object containing the meta data
 */
function identify (sourceFile) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourceFile)
      .ffprobe(0, function (err, result) {
        if (err) {
          reject(err)
        } else {
          const stream = result.streams[0]
          const format = result.format && result.format.format_name? result.format.format_name : undefined
          const duration = parseFloat(stream.duration)
          const sampleRate = (stream.sample_rate && stream.sample_rate !== 'N/A')? parseInt(stream.sample_rate) : 0
          const sampleCount = Math.round(stream.duration * sampleRate)
          const channelCount = stream.channels
          const channelLayout = stream.channel_layout
          const bitRate = (stream.bit_rate && stream.bit_rate !== 'N/A')? parseInt(stream.bit_rate) : 0;
          const codec = stream.codec_name
          const tags = result.format && result.format.tags? result.format.tags : {}
          resolve({ format, duration, sampleCount, channelLayout, channelCount, bitRate, sampleRate, codec, tags })
        }
      })
  })
}

/**
 * Split an audio file into segments of a maximum duration
 * - if the source file is longer than the maximum duration then it will be cut into segments of maximum duration in length
 * - the last output file may be shorter than the maximum duration
 * @param {String} sourceFile - path to source file on disk
 * @param {String} destinationPath - path (directory) to output the file segments
 * @param {Number} maxDuration - the maximum duration of a segment (in seconds)
 * @returns {Object[]} - array with objects with segments information (local path, duration)
 */
function split (sourceFile, destinationPath, maxDuration) {
  destinationPath += destinationPath.endsWith('/') ? '' : '/'
  const outputFileFormat = destinationPath + path.basename(sourceFile).replace(/\.([^.]*)$/, '.%03d.$1') // convert hello.wav to hello.%03d.wav

  return new Promise((resolve, reject) => {
    const command = ffmpeg(sourceFile)
      .noVideo()
      .audioCodec('copy')
      .output(outputFileFormat)
      .outputOptions([
        '-f segment', // output as file segments
        `-segment_time ${maxDuration}`, // split into X sec segments
        // '-segment_frames 0,24000,48000' // split into segments by frame boundaries - maybe useful in future
        '-segment_list pipe:1' // output a list of the created segments to stdout
      ]).on('start', function (commandLine) {
        console.log('Spawned Ffmpeg with command: ' + commandLine)
      }).on('progress', function (progress) {
        console.log('Processing: ' + progress.percent + '% done')
      })

    const timeout = setTimeout(function () {
      command.kill()
      reject(Error('Timeout')) // TODO: move to errors
    }, 60000)

    command
      .on('error', function (err, stdout, stderr) {
        clearTimeout(timeout)
        reject(err)
      })
      .on('end', function (stdout, stderr) {
        clearTimeout(timeout)
        const outputFiles = stdout.trim().split('\n').map(async (x) => {
          try {
            const filePath = path.join(destinationPath, x)
            const meta = await identify(filePath)
            return {
              path: filePath,
              meta: meta
            }
          }
          catch (e) { reject(e) }
        })
        resolve(Promise.all(outputFiles))
      })
      .run()
  })
}

function convert (sourceFile, destinationPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(sourceFile)
      .noVideo()
      .output(destinationPath)
      .on('start', function (commandLine) {
        console.log('Spawned Ffmpeg with command: ' + commandLine)
      }).on('progress', function (progress) {
        console.log('Processing: ' + progress.percent + '% done')
      })

    const timeout = setTimeout(function () {
      command.kill()
      reject(Error('Timeout')) // TODO: move to errors
    }, 60000)

    command
      .on('error', function (err, stdout, stderr) {
        clearTimeout(timeout)
        reject(err)
      })
      .on('end', async function (stdout, stderr) {
        clearTimeout(timeout)
        try {
          const meta = await identify(destinationPath)
          resolve({
            path: destinationPath,
            meta: meta
          })
        }
        catch (e) { reject(e) }
      })
      .run()
  })
}

module.exports = {
  identify,
  split,
  convert,
}
