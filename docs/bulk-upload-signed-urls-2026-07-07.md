# Bulk upload signed URLs

Date: 2026-07-07
Status: implemented

## Goal

Reduce uploader round trips by letting a client request signed upload URLs for multiple audio files in one API call while preserving the existing security model: one Mongo `StreamUpload` document and one object-scoped signed PUT URL per file.

The existing single-file endpoint remains unchanged:

```http
POST /uploads
```

The additive bulk endpoint is:

```http
POST /uploads/bulk
```

## Request

```json
{
  "uploads": [
    {
      "filename": "0a1824085e3f-2021-06-08T19-26-40.flac",
      "timestamp": "2021-06-08T19:26:40.000Z",
      "stream": "0a1824085e3f",
      "duration": 60000,
      "fileSize": 10000000,
      "sampleRate": 48000,
      "targetBitrate": 1,
      "checksum": "..."
    }
  ]
}
```

Each item uses the same fields and validation as `POST /uploads`.

## Response

A well-formed bulk request returns HTTP 200 even if some individual items fail. Item-level failures are returned inline, so valid files can still upload.

```json
{
  "requested": 3,
  "created": 2,
  "failed": 1,
  "uploads": [
    {
      "index": 0,
      "ok": true,
      "uploadId": "...",
      "url": "https://...",
      "path": "stream/upload.flac",
      "bucket": "rfcx-ingest-production",
      "uploadTargetId": "legacy-env-upload-bucket"
    },
    {
      "index": 1,
      "ok": false,
      "status": 400,
      "error": "Duplicate."
    }
  ]
}
```

Top-level wrapper errors still use normal HTTP errors:

- `400` if `uploads` is missing, not an array, empty, or over the configured item limit.
- `503` if upload creation is paused.

## Limits

Default maximum items per request: `100`.

Override with:

```text
UPLOAD_BULK_MAX_ITEMS=<count>
```

## Security and routing properties

- The endpoint does **not** issue a broad prefix credential or multi-object token.
- Every successful item gets exactly one object-scoped signed PUT URL.
- Every successful item persists its own immutable `uploadSource`.
- Upload target selection currently runs per item, using the same context as single-file uploads: stream, user, project, duration, file extension, and timestamp.
- Project recording-minute limits include already-created pending uploads, so sequential item creation in a bulk request naturally counts earlier successful items in the same batch.

## Operational notes

- Partial success is intentional. Clients should upload only `ok=true` items and surface or retry `ok=false` items individually.
- The `index` field maps each result back to the original request item.
- Existing clients using `POST /uploads` are unaffected.
