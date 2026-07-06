const registryPath = './upload-target-registry'
jest.mock(registryPath)
const registry = require(registryPath)

const originalEnv = process.env

function reloadUploadTargets () {
  jest.resetModules()
  jest.doMock(registryPath, () => registry)
  return require('./upload-targets')
}

describe('upload target selection', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PLATFORM: 'amazon',
      UPLOAD_BUCKET: 'rfcx-ingest-production',
      UPLOAD_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      UPLOAD_S3_REGION_ID: 'auto',
      UPLOAD_S3_FORCE_PATH_STYLE: 'true'
    }
    registry.selectRegistryUploadTarget.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('defaults to env-backed legacy target', async () => {
    const uploadTargets = reloadUploadTargets()
    const target = await uploadTargets.selectUploadTarget()

    expect(target).toEqual(expect.objectContaining({
      id: 'legacy-env-upload-bucket',
      provider: 's3-compatible',
      bucket: 'rfcx-ingest-production',
      endpoint: 'https://example.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true
    }))
    expect(registry.selectRegistryUploadTarget).not.toHaveBeenCalled()
  })

  test('shadow mode queries registry but still returns env target', async () => {
    process.env.UPLOAD_TARGET_REGISTRY_MODE = 'shadow'
    registry.selectRegistryUploadTarget.mockResolvedValue({
      id: 'db-target',
      version: 1,
      provider: 's3-compatible',
      bucket: 'other-bucket',
      endpoint: 'https://other.example',
      region: 'auto',
      forcePathStyle: true
    })
    const uploadTargets = reloadUploadTargets()
    const target = await uploadTargets.selectUploadTarget({ streamId: 'stream-1' })

    expect(registry.selectRegistryUploadTarget).toHaveBeenCalledWith({ streamId: 'stream-1' })
    expect(target.id).toBe('legacy-env-upload-bucket')
    expect(target.bucket).toBe('rfcx-ingest-production')
  })

  test('active mode returns registry-selected target', async () => {
    process.env.UPLOAD_TARGET_REGISTRY_MODE = 'active'
    registry.selectRegistryUploadTarget.mockResolvedValue({
      id: 'db-target',
      version: 2,
      provider: 's3-compatible',
      bucket: 'r2-locale-a',
      endpoint: 'https://r2-a.example',
      region: 'auto',
      forcePathStyle: true
    })
    const uploadTargets = reloadUploadTargets()
    const target = await uploadTargets.selectUploadTarget()

    expect(target).toEqual(expect.objectContaining({
      id: 'db-target',
      version: 2,
      bucket: 'r2-locale-a'
    }))
  })

  test('registry errors fall back to env target', async () => {
    process.env.UPLOAD_TARGET_REGISTRY_MODE = 'active'
    registry.selectRegistryUploadTarget.mockRejectedValue(new Error('registry unavailable'))
    const uploadTargets = reloadUploadTargets()
    const target = await uploadTargets.selectUploadTarget()

    expect(target.id).toBe('legacy-env-upload-bucket')
    expect(target.bucket).toBe('rfcx-ingest-production')
  })
})
