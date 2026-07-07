# Upload ingestion status API

Date: 2026-07-07
Status: implemented

## Goal

Expose upload ingestion progress and final recording identifiers to uploader clients so they can show better UX, poll for completion, and decide when a retry is appropriate.

## Endpoints

Single upload status:

```http
GET /uploads/{uploadId}/status
```

Bulk upload status:

```http
POST /uploads/status
Content-Type: application/json

{ "uploadIds": ["..."] }
```

The bulk endpoint returns per-id results and does not fail the whole request if one id is missing or unauthorized.

## Response shape

```json
{
  "uploadId": "...",
  "status": 20,
  "statusName": "INGESTED",
  "terminal": true,
  "retryable": false,
  "nextAction": "complete",
  "failureMessage": null,
  "createdAt": "...",
  "updatedAt": "...",
  "stream": {
    "id": "0a1824085e3f",
    "projectId": "...",
    "siteId": "...",
    "arbimonProjectId": "...",
    "arbimonSiteId": "..."
  },
  "recording": {
    "streamSourceFileId": "...",
    "ingestedAt": "...",
    "segments": [
      { "id": "...", "start": "...", "end": "...", "path": "..." }
    ]
  }
}
```

`recording` appears once ingestion has successfully created Core stream-source-file/segment data and the ingest worker has persisted that result back to Mongo.

## Status semantics

| Status | Name | terminal | retryable | nextAction |
|---:|---|---|---|---|
| 0 | WAITING | false | false | wait |
| 10 | UPLOADED | false | false | wait |
| 20 | INGESTED | true | false | complete |
| 30 | FAILED | true | conditional | retry_upload for generic transient failures, otherwise review_error |
| 31 | DUPLICATE | true | false | ignore_duplicate |
| 32 | CHECKSUM | true | true | retry_upload |

Retries should request a fresh upload URL for the same file metadata, not reuse an old signed URL. `FAILED` is retryable only when the persisted failure message is the generic transient worker error; deterministic failures such as unsupported format need client/user correction instead of blind retry.

## Persistence

On successful ingestion, the worker persists an `ingestionResult` subdocument on the Mongo `StreamUpload` document containing:

- `streamSourceFileId`
- `streamId`
- `projectId`
- optional site/Arbimon ids when present in the Core response
- `ingestedAt`
- segment ids, starts, ends, and storage paths

Status reads are therefore fast Mongo reads and do not need to re-query Core on every client poll.
