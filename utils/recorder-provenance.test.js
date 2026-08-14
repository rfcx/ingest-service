const {
  checkRecordingTimestamp,
  detectRecorder,
  extractMetadataDate
} = require('./recorder-provenance')

/**
 * Provenance-aware historical-date validation.
 *
 * The behaviours that matter are asymmetric, so they are tested separately:
 *  - a GENUINE digitised archive (no recorder tags) must be ACCEPTED, however
 *    old it is. This is the capability being added.
 *  - a digital recorder claiming a pre-1971 date must be REJECTED. This is the
 *    unset-clock class the old blanket rule existed to catch.
 * Both directions are load-bearing: relaxing one without the other either
 * blocks real archives or lets silently-wrong data in.
 *
 * The fixtures below are REAL metadata shapes taken from production
 * (core.stream_source_files.meta), not invented ones.
 */

const AUDIOMOTH_TAGS = {
  comment: 'Recorded at 19:30:00 09/08/2025 (UTC-5) by AudioMoth 248D9B04645707D7 at medium gain while battery was 4.5V and temperature was 12.3C.',
  artist: 'AudioMoth 248D9B04645707D7',
  encoder: 'Lavf61.7.100'
}

const GUANO_TAGS = {
  comment: 'GUANO|Version:1.0;Firmware Version:4.7;Make:Wildlife Acoustics, Inc.;Model:Song Meter Micro;Serial:2MM18874;WA|Song Meter|Prefix:2MM18874;WA|Song Meter|Audio settings:rate:24000,gain:18;Length:60.000'
}

const XENO_CANTO_TAGS = {
  title: 'Chestnut-rumped Babbler (Stachyris maculata)',
  album: 'xeno-canto',
  artist: 'Peter Boesman',
  comment: 'XC360083 C Peter Boesman'
}

const ENCODER_ONLY_TAGS = { encoder: 'Lavf58.24.101' }

const AVISOFT_TAGS = {
  encoded_by: 'Avisoft-RECORDER',
  date: '2012-12-05',
  time_reference: '46332746928'
}

const utc = (iso) => new Date(iso)

describe('recorder provenance: historical dates', () => {
  describe('ACCEPTS genuine archival material', () => {
    test('1955 field recording with no recorder metadata', () => {
      expect(checkRecordingTimestamp(utc('1955-06-12T10:15:00Z'), {})).toBeNull()
    })

    test('1941 recording with only an encoder tag (transcoded archive)', () => {
      expect(checkRecordingTimestamp(utc('1941-01-01T01:01:01Z'), ENCODER_ONLY_TAGS)).toBeNull()
    })

    test('1900 digitised archive', () => {
      expect(checkRecordingTimestamp(utc('1900-01-01T01:01:01Z'), {})).toBeNull()
    })

    test('xeno-canto archival upload INSIDE the epoch-drift window', () => {
      // Real production row: placeholder date, legitimate attributed recording.
      // A naive date-window guard would have destroyed this.
      expect(checkRecordingTimestamp(utc('1969-12-31T17:00:00Z'), XENO_CANTO_TAGS)).toBeNull()
      expect(checkRecordingTimestamp(utc('1970-01-13T09:00:00Z'), XENO_CANTO_TAGS)).toBeNull()
    })

    test('null/absent tags do not throw', () => {
      expect(checkRecordingTimestamp(utc('1960-05-05T00:00:00Z'), null)).toBeNull()
      expect(checkRecordingTimestamp(utc('1960-05-05T00:00:00Z'), undefined)).toBeNull()
    })
  })

  describe('REJECTS impossible digital-recorder dates', () => {
    test('AudioMoth claiming 1970 (unset clock)', () => {
      const reason = checkRecordingTimestamp(utc('1970-01-01T00:00:00Z'), AUDIOMOTH_TAGS)
      expect(reason).toMatch(/AudioMoth/)
      expect(reason).toMatch(/clock/)
    })

    test('Song Meter / GUANO claiming 1970', () => {
      const reason = checkRecordingTimestamp(utc('1970-01-05T12:00:00Z'), GUANO_TAGS)
      expect(reason).not.toBeNull()
      expect(reason).toMatch(/cannot predate/)
    })

    test('the real misparsed AudioMoth file from production', () => {
      // parsed start 1901-02-16, but the comment says 17/02/2019.
      // Filename was 160219010101.WAV — DDMMYY read as YYMMDD.
      const reason = checkRecordingTimestamp(utc('1901-02-16T01:02:00Z'), {
        comment: 'Recorded at 06:00:00 17/02/2019 (UTC) by AudioMoth 0FE081F80FE081F0 at gain setting 4 while battery state was 4.7V',
        encoder: 'Lavf58.24.101'
      })
      expect(reason).not.toBeNull()
    })
  })

  describe('REJECTS absurd dates regardless of provenance', () => {
    test.each([
      ['0218-03-21T05:10:00Z'],
      ['0616-01-01T00:00:00Z'],
      ['1501-02-03T00:00:00Z']
    ])('%s is a parse failure', (iso) => {
      const reason = checkRecordingTimestamp(utc(iso), {})
      expect(reason).toMatch(/not a plausible recording date/)
    })

    test('an invalid date is reported, not silently accepted', () => {
      expect(checkRecordingTimestamp(new Date('nonsense'), {})).toMatch(/not a valid date/)
    })
  })

  describe('REJECTS metadata contradiction (brand-independent)', () => {
    test('Avisoft: parsed 1901 vs embedded 2012 is rejected (by provenance, first)', () => {
      // Avisoft IS a known digital recorder, so rule 2 fires before rule 3.
      // Either rejection is correct; assert only that it is rejected and that
      // the reason is actionable. (Asserting the contradiction wording here
      // was a TEST bug: it presumed an ordering the code does not promise.)
      const reason = checkRecordingTimestamp(utc('1901-12-09T09:28:05Z'), AVISOFT_TAGS)
      expect(reason).not.toBeNull()
      expect(reason).toMatch(/cannot predate|disagrees with the date stored inside the file/)
    })

    test('contradiction is caught for an UNKNOWN recorder brand too', () => {
      // The point of rule 3: catch misparsed filenames even when no known
      // recorder is named, so the guard is not limited to our brand list.
      const reason = checkRecordingTimestamp(utc('1985-11-19T00:00:00Z'), {
        encoded_by: 'SomeUnlistedDevice',
        date: '2012-11-19'
      })
      expect(reason).toMatch(/disagrees with the date stored inside the file/)
    })

    test('a timezone-sized difference is NOT a contradiction', () => {
      // same day, different zone rendering — must not trip the guard
      expect(checkRecordingTimestamp(utc('2012-12-05T23:00:00Z'), AVISOFT_TAGS)).toBeNull()
      expect(checkRecordingTimestamp(utc('2012-12-04T01:00:00Z'), AVISOFT_TAGS)).toBeNull()
    })
  })

  describe('modern recordings are unaffected', () => {
    test.each([
      ['2025-08-09T19:30:00Z', AUDIOMOTH_TAGS],
      ['2024-01-15T14:30:00Z', GUANO_TAGS],
      ['1990-06-01T00:00:00Z', {}]
    ])('%s is accepted', (iso, tags) => {
      expect(checkRecordingTimestamp(utc(iso), tags)).toBeNull()
    })

    test('the 1971 boundary itself is accepted for a recorder-tagged file', () => {
      // NOTE: the tags must AGREE with the timestamp, or rule 3 correctly
      // rejects it. Pairing a 1971 date with a 2025 AudioMoth comment was a
      // self-contradictory fixture (a TEST bug, caught here) — the code was
      // right to reject it.
      const tags = {
        comment: 'Recorded at 00:00:00 01/01/1971 (UTC) by AudioMoth 248D9B04645707D7 at medium gain',
        artist: 'AudioMoth 248D9B04645707D7'
      }
      expect(checkRecordingTimestamp(utc('1971-01-01T00:00:00Z'), tags)).toBeNull()
    })
  })

  describe('helpers', () => {
    test('detectRecorder identifies the real production shapes', () => {
      expect(detectRecorder(AUDIOMOTH_TAGS)).toMatch(/AudioMoth/)
      expect(detectRecorder(GUANO_TAGS)).not.toBeNull()
      expect(detectRecorder(AVISOFT_TAGS)).toMatch(/Avisoft/)
      expect(detectRecorder(XENO_CANTO_TAGS)).toBeNull()
      expect(detectRecorder(ENCODER_ONLY_TAGS)).toBeNull()
      expect(detectRecorder({})).toBeNull()
    })

    test('extractMetadataDate reads both real shapes', () => {
      expect(extractMetadataDate(AUDIOMOTH_TAGS).toISOString().slice(0, 10)).toBe('2025-08-09')
      expect(extractMetadataDate(AVISOFT_TAGS).toISOString().slice(0, 10)).toBe('2012-12-05')
      expect(extractMetadataDate({})).toBeNull()
    })
  })
})
