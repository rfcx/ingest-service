const ffmpeg = require('fluent-ffmpeg')
const sha1File = require('sha1-file')
const path = require('path')
const { splitTimeoutMs, convertTimeoutMs } = require('../utils/limits')

/**
 * Probe an audio file to find its sample rate, duration and other meta data
 * - result: { format: 'wav', duration: 1.5, sampleCount: 66150, channelCount: 1, bitRate: 722944, sampleRate: 44100 }
 * @param {String} sourceFile - path to source file on disk
 * @returns {Promise<Object>} - an object containing the meta data
 */
/**
 * Measure a file's TRUE audio length by decoding it.
 *
 * WHY THIS EXISTS. `identify()` reads ffprobe's `stream.duration`, which for
 * some containers reports the segment's END POSITION IN THE ORIGINAL TIMELINE
 * rather than its own length. Measured on opus segments cut by `split()`:
 *
 *   segment 0: stream.duration 60.0065  (true 59.9935)
 *   segment 1: stream.duration 120.0065 (true 59.9935)   <-- cumulative
 *   segment 2: stream.duration 125.0130 (true  5.0135)   <-- cumulative
 *
 * `setAdditionalFileAttrs()` ACCUMULATES those values to build each segment's
 * start/end, so the error compounds: a real 301.7s opus recording was recorded
 * in production as spanning 1202s (4x). `duration_ts` is cumulative too, and
 * `sampleCount` is computed FROM stream.duration, so neither is a way out.
 *
 * Decoding is the only source that is right for every container. It costs ~90ms
 * for a 60s segment (measured), which is negligible against the transcode and
 * upload work already happening per segment.
 *
 * DECODES TO THE `wav` MUXER, writing to the platform's null DEVICE. Decoding
 * is required (the container metadata is what we distrust); discarding the
 * output costs nothing.
 *
 * Uses fluent-ffmpeg like the rest of this file — same binary resolution
 * (FFMPEG_PATH), same error/timeout surface, same thing to mock in tests. An
 * earlier revision spawned ffmpeg directly because `.outputFormat()` failed
 * with "Output format wav is not available"; that turned out to be
 * fluent-ffmpeg 2.1.2's format probe being unable to parse ffmpeg 8.x's
 * `-formats` output (0 formats discovered locally, 400 on the prod image's
 * ffmpeg 4.4.2). It was never a production failure, and 2.1.3 fixes the probe
 * outright (411 formats on the same local ffmpeg 8.1.1), so there is no reason
 * to bypass the wrapper.
 *
 * Returns undefined if the probe fails; callers fall back to identify()'s value
 * rather than dropping the segment — a slightly wrong timestamp beats a lost
 * recording.
 */
function measureDecodedDuration (sourceFile) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) { return }
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }

    const command = ffmpeg(sourceFile)
      .output(process.platform === 'win32' ? 'NUL' : '/dev/null')
      .outputFormat('wav')
      .outputOptions(['-progress pipe:1'])
      .on('error', () => { done(undefined) })
      .on('end', (stdout) => {
        // `-progress` writes repeating key=value blocks; the LAST out_time_us
        // is the total decoded length.
        const matches = String(stdout || '').match(/out_time_us=(\d+)/g)
        if (!matches || matches.length === 0) { done(undefined); return }
        const us = parseInt(matches[matches.length - 1].split('=')[1], 10)
        done(Number.isFinite(us) ? us / 1000000 : undefined)
      })

    const timeout = setTimeout(() => { command.kill(); done(undefined) }, convertTimeoutMs)
    command.run()
  })
}

function identify (sourceFile) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourceFile)
      .ffprobe(0, function (err, result) {
        if (err) {
          reject(err)
        } else {
          const stream = result.streams[0]
          const format = result.format && result.format.format_name ? result.format.format_name : undefined
          const duration = parseFloat(stream.duration)
          const sampleRate = (stream.sample_rate && stream.sample_rate !== 'N/A') ? parseInt(stream.sample_rate) : 0
          const sampleCount = Math.round(stream.duration * sampleRate)
          const channelCount = stream.channels
          const channelLayout = stream.channel_layout
          const bitRate = (stream.bit_rate && stream.bit_rate !== 'N/A')
            ? parseInt(stream.bit_rate)
            : (result.format && result.format.bit_rate && result.format.bit_rate !== 'N/A' ? parseInt(result.format.bit_rate) : 0)
          const codec = stream.codec_name
          const tags = result.format && result.format.tags ? result.format.tags : {}
          const size = result.format && result.format.size ? result.format.size : 0
          const checksum = sha1File(sourceFile)
          resolve({ format, duration, sampleCount, channelLayout, channelCount, bitRate, sampleRate, codec, tags, size, checksum })
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
// Sentinel for a trailing segment that ffprobe refused entirely (see the catch
// inside split()). A unique object, so it can never collide with a real result.
const TRAILING_DROPPED = Symbol('trailing-segment-dropped')

function split (sourceFile, destinationPath, maxDuration) {
  destinationPath += destinationPath.endsWith('/') ? '' : '/'
  const outputFileFormat = destinationPath + path.basename(sourceFile).replace(/\.([^.]*)$/, '.%03d.$1') // convert hello.wav to hello.%03d.wav

  return new Promise((resolve, reject) => {
    const command = ffmpeg(sourceFile, { stdoutLines: 50000 })
      .noVideo()
      .audioCodec('copy')
      .output(outputFileFormat)
      .outputOptions([
        '-f segment', // output as file segments
        `-segment_time ${maxDuration}`, // split into X sec segments
        // '-segment_frames 0,24000,48000' // split into segments by frame boundaries - maybe useful in future
        '-segment_list pipe:1' // output a list of the created segments to stdout
      ]).on('start', function (commandLine) {
        // console.info('Spawned Ffmpeg with command: ' + commandLine)
      }).on('progress', function (progress) {
        // console.info('Processing: ' + progress.percent + '% done')
      })

    const timeout = setTimeout(function () {
      command.kill()
      reject(Error('Timeout')) // TODO: move to errors
    }, splitTimeoutMs)

    command
      .on('error', function (err, stdout, stderr) {
        clearTimeout(timeout)
        reject(err)
      })
      .on('end', function (stdout, stderr) {
        clearTimeout(timeout)
        // Names of the segments ffmpeg reported, in order. Needed so a probe
        // failure can tell a TRAILING runt (droppable) from an interior
        // segment (a real fault) -- see the catch below.
        const segmentNames = stdout.trim().split('\n')
        const outputFiles = segmentNames.map(async (x) => {
          try {
            const filePath = path.join(destinationPath, x)
            const meta = await identify(filePath)

            // CORRECT THE SEGMENT DURATION WHERE THE CONTAINER LIES.
            //
            // Stream-copy segmentation leaves some containers (opus observed;
            // any packet-based format is a candidate) reporting the segment's
            // END POSITION IN THE SOURCE TIMELINE instead of its own length.
            // setAdditionalFileAttrs() accumulates these, so the error
            // compounds across a file — a real 301.7s opus recording landed in
            // production spanning 1202s.
            //
            // The decoded length is authoritative for every container, so it
            // wins whenever the two DISAGREE MATERIALLY. The 50ms threshold
            // keeps ordinary probe/decode jitter (wav/mp3/m4a all agree to
            // ~1-15ms) from rewriting values that were already right.
            const decoded = await measureDecodedDuration(filePath)
            if (decoded !== undefined && Number.isFinite(meta.duration) &&
                Math.abs(decoded - meta.duration) > 0.05) {
              console.info(
                `[segment-duration] corrected ${path.basename(filePath)}: ` +
                `probed=${meta.duration}s decoded=${decoded}s`
              )
              meta.duration = decoded
              // sampleCount is derived FROM duration in identify(), so it
              // inherits the same error and must be recomputed with it.
              if (meta.sampleRate) { meta.sampleCount = Math.round(decoded * meta.sampleRate) }
            }

            return {
              path: filePath,
              meta: meta
            }
          } catch (e) {
            // AN UNPROBEABLE TRAILING SEGMENT MUST NOT KILL THE WHOLE INGEST.
            //
            // Stream-copy segmentation can emit a runt final segment holding a
            // PARTIAL frame, which ffprobe refuses outright rather than
            // reporting badly:
            //   [mp3] Invalid frame size (417): Could not seek to 879.
            //   <file>: Invalid argument            (ffprobe exit 1)
            // so identify() THROWS. Measured on mp3: this happens whenever the
            // source length is an exact multiple of the segment length (60,
            // 120, 180, 240, 300, 360, 420, 600s all reproduce) -- i.e. exactly
            // the durations scheduled recorders produce.
            //
            // Previously this path called reject(e) and returned undefined,
            // which ALSO left an undefined hole in the Promise.all array, so
            // the .then() below threw a misleading
            // "Cannot read properties of undefined (reading 'meta')" before the
            // rejection surfaced -- masking the real cause.
            //
            // The runt carries NO audio (measured: 880 bytes, ffmpeg reports no
            // decoded time, measureDecodedDuration() returns undefined), so
            // dropping it loses nothing. This generalises the sampleCount guard
            // below to the case where the segment cannot be probed AT ALL.
            //
            // Deliberately narrow: only a TRAILING segment is dropped. A
            // mid-file probe failure is a real fault and must still fail the
            // whole split, because silently discarding interior audio would
            // corrupt the timeline.
            //
            // NOTE ON THE MECHANISM: we must SIGNAL the interior failure by
            // returning a marker and re-throwing in the aggregation step below,
            // NOT by calling reject() here. `resolve(Promise.all(...))` runs
            // synchronously before any of these async callbacks settle, so this
            // promise is already locked to that inner promise and a later
            // reject() is a NO-OP. (That is precisely why the original code's
            // reject(e) never surfaced and the caller saw the misleading
            // "Cannot read properties of undefined" instead of the ffprobe
            // error.) Caught by mutation testing: forcing isTrailing=false left
            // the mp3 cases still passing, which they could only do if the
            // interior branch were unreachable in effect.
            const filePath = path.join(destinationPath, x)
            const isTrailing = x === segmentNames[segmentNames.length - 1]
            if (isTrailing) {
              console.info(
                `[segment-drop] trailing segment ${path.basename(filePath)} could not be probed ` +
                `(${e && e.message}); dropping it -- it carries no decodable audio`
              )
              return TRAILING_DROPPED
            }
            return { __probeError: e, path: filePath }
          }
        })
        /*
        * There is a very rare case that the segment is very small, 0.0000x second.
        * With this small segment, the sample count will be null so we have to exclude it
        */
        resolve(Promise.all(outputFiles).then(files => {
          // An INTERIOR segment that could not be probed is a real fault: fail
          // the split rather than silently shortening the recording.
          const broken = files.find(f => f && f.__probeError)
          if (broken) {
            throw broken.__probeError
          }
          // Drop the trailing runt segment, if the catch above flagged one.
          while (files.length && files[files.length - 1] === TRAILING_DROPPED) {
            files.pop()
          }
          if (!files.length) {
            throw new Error('No probeable segments were produced')
          }
          if (!files[files.length - 1].meta.sampleCount) {
            files.pop()
          }
          return files
        }))
      })
      .run()
  })
}

function convert (sourceFile, destinationPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(sourceFile)
      .noVideo()
      .output(destinationPath)
      .outputOptions([
        '-ac 1'
      ])
      .on('start', function (commandLine) {
        // console.info('Spawned Ffmpeg with command: ' + commandLine)
      }).on('progress', function (progress) {
        // console.info('Processing: ' + progress.percent + '% done')
      })

    const timeout = setTimeout(function () {
      command.kill()
      reject(Error('Timeout')) // TODO: move to errors
    }, convertTimeoutMs)

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
        } catch (e) { reject(e) }
      })
      .run()
  })
}

module.exports = {
  identify,
  split,
  convert,
  // Exported for testing: the segment-duration correction is the whole point of
  // this change, so it has to be verifiable without running a full split().
  measureDecodedDuration
}
