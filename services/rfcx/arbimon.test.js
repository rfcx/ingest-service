const axios = require('../../utils/axios')

jest.mock('../../utils/axios')

const { getProjectUploadLimitSummary } = require('./arbimon')

const UNLIMITED = { isLocked: false, recordingMinutesLimit: null, recordingMinutesCount: 0 }

describe('getProjectUploadLimitSummary', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  test('returns the summary payload on success', async () => {
    const summary = { isLocked: false, recordingMinutesLimit: 6000, recordingMinutesCount: 120 }
    axios.get.mockResolvedValue({ data: summary })
    await expect(getProjectUploadLimitSummary('Bearer t', 'proj1')).resolves.toEqual(summary)
  })

  test('fails open (unlimited) on 404 — endpoint/project not present', async () => {
    axios.get.mockRejectedValue({ response: { status: 404 } })
    await expect(getProjectUploadLimitSummary('Bearer t', 'proj1')).resolves.toEqual(UNLIMITED)
  })

  test('fails open (unlimited) on 500 — quota chain unhealthy (e.g. legacy email-session on a machine token)', async () => {
    axios.get.mockRejectedValue({ response: { status: 500 } })
    await expect(getProjectUploadLimitSummary('Bearer t', 'proj1')).resolves.toEqual(UNLIMITED)
  })

  test('fails open (unlimited) on 503 — dependency down', async () => {
    axios.get.mockRejectedValue({ response: { status: 503 } })
    await expect(getProjectUploadLimitSummary('Bearer t', 'proj1')).resolves.toEqual(UNLIMITED)
  })

  test('does NOT fail open on 401 — real auth failure propagates', async () => {
    axios.get.mockRejectedValue({ response: { status: 401 }, message: 'Unauthorized' })
    await expect(getProjectUploadLimitSummary('Bearer t', 'proj1')).rejects.toBeDefined()
  })

  test('does NOT fail open on 403 — forbidden propagates', async () => {
    axios.get.mockRejectedValue({ response: { status: 403 }, message: 'Forbidden' })
    await expect(getProjectUploadLimitSummary('Bearer t', 'proj1')).rejects.toBeDefined()
  })
})
