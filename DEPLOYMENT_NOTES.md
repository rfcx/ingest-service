# Deployment Notes

## v1.1.0

- Delete the `ingest-service` deployment and `ingest-service-service` service from Kubernetes (it is replaced by `ingest-service-api` and `-tasks`)
- Change `INGEST_SERVICE_BASE_URL` in `noncore-api-configmap` to `http://ingest-service-api-service.production.svc.cluster.local/`

## v1.0.4

- Delete `ARBIMON_ENABLED` and `ARBIMON_HOST` env vars

## v1.0.3

- Add `ERROR_BUCKET` env var with `rfcx-streams-errors-staging` and `rfcx-streams-errors-production` values (Buckets are already created by Stas)

## v1.0.2

- Check that `ARBIMON_ENABLED` env var exists and set to `true`

## v1.0.1

- Add `DEVICE_API_HOST` env variable. Set it to `https://staging-device-api.rfcx.org/` for staging and `https://device-api.rfcx.org/` fpr production

## v1.0.0

_None_
