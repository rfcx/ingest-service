const registry = require('./upload-target-registry')

describe('upload target registry policy selection', () => {
  const targets = [
    {
      id: 'legacy-env-upload-bucket',
      version: 1,
      provider: 's3-compatible',
      bucket: 'rfcx-ingest-production',
      endpoint: 'https://example.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true
    },
    {
      id: 'r2-enam-upload-bucket',
      version: 1,
      provider: 's3-compatible',
      bucket: 'rfcx-ingest-enam',
      endpoint: 'https://example.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true
    }
  ]

  test('falls back to first enabled target when no active policy exists', () => {
    expect(registry.selectTargetFromPolicy(targets, null)).toBe(targets[0])
  })

  test('selects target from active single-target policy', () => {
    const selected = registry.selectTargetFromPolicy(targets, {
      mode: 'single-target',
      targetId: 'r2-enam-upload-bucket'
    })

    expect(selected).toBe(targets[1])
  })

  test('rejects active policy that references a missing or disabled target', () => {
    expect(() => registry.selectTargetFromPolicy(targets, {
      mode: 'single-target',
      targetId: 'rfcx-ingest-eu'
    })).toThrow('Active upload target policy references disabled or missing target: rfcx-ingest-eu')
  })

  test('rejects unsupported policy modes', () => {
    expect(() => registry.selectTargetFromPolicy(targets, {
      mode: 'geo-weighted',
      targetId: 'r2-enam-upload-bucket'
    })).toThrow('Unsupported upload target policy mode: geo-weighted')
  })
})
