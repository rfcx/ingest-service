# Ingest Service

A mockup service for ingesting files via GCS


## Requirements

- Node 10.x.x
- [FFmpeg](https://ffmpeg.org) for splitting and identifying audio files
- [MongoDB](https://www.mongodb.com/) for storing uploads data
- [Google Cloud Pub/Sub](https://cloud.google.com/pubsub/) (when used in google mode) for receiving notifications about new ingestions
- [Google Cloud Ctorage](https://cloud.google.com/storage/) (when used in google mode) for audio files downloading and uploading
- [Amazon SQS](https://aws.amazon.com/sqs/) (when used in amazon mode) for receiving notifications about new ingestions
- [Amazon S3](https://aws.amazon.com/s3/) (when used in amazon mode) for audio files downloading and uploading

Optional:
- [ES Lint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) for VS Code


## Setup project in Google Cloud

Create a Google Cloud project (e.g. `rfcx-ingest-staging`) -- preferably attached to the RFCx organization.

Follow [these](https://cloud.google.com/storage/docs/reporting-changes?authuser=1#prereqs) instructions to make sure you have Pub/Sub and Cloud Storage enabled for your project

Get a Service Account key for the Google Cloud project with roles: `Pub/Sub Subscriber`, `Storage Object Admin`, `Storage Object Creator`, `Storage Object Viewer` following [these](https://cloud.google.com/pubsub/docs/access-control?authuser=1#console) instructions.

Create two Cloud Storage buckets: one for uploaded files, one for ingested files

Open Active Cloud Shell and create storage-pubsub notification:
```
gsutil notification create -t ingest-service-upload-staging -e OBJECT_FINALIZE -f json gs://rfcx-ingest-staging
```

Check notifications:
```
gsutil notification list gs://rfcx-ingest-staging
```

## Local development

Copy `functions/.env.example` to `functions/.env`. (follow the instructions in .env.example for minimum set of env vars).

Install dependencies:
```
cd functions
npm install
```

## Database setup
You can start local MongoDB using Docker with command:
```
npm run start.mongo
```
MongoDB will start on `localhost` with port `27017`, db name `admin`, user `admin-user`, and password `test`.

And stop it with command:
```
npm run stop.mongo
```

### For Node/Amazon

Run the API endpoints (with live reloading):
```
npm run dev
```

In production the API endpoints are run directly:
```
npm start
```

Use these [instructions](https://confluence.rfcx.org/display/RD/Configuring+S3+new+file+trigger+to+SQS+queue "Confluence document") to configure S3 new file trigger to SQS queue.

TODO: How to run the background job (SQS Consumer) and test the triggers from S3 to ingest


## Lint

The project uses ES Lint. It is installed as a dev dependency, so simply `npm run lint` to check for errors or `npm run lint-fix` to attempt to auto-fix the errors.

VS Code support for lint is via the [ES Lint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint).


## Testing

The `example` folder contains `upload.js` which can be run as `node upload.js filename.mp3` to perform the client-side steps to upload the file (get a signed url, upload the file to storage, and check the upload status). (Install the dependencies before you start `cd example ; npm i`.)

To test the trigger from storage, use the `npm run shellfb` described above (from the `functions` folder).


## Ingestion methods

1. Checkin endpoint

Set the `INGEST_METHOD` to `checkin` in the environment variables (.env). No extra configuration required.

2. Manual S3 upload and audio endpoint

Set the `INGEST_METHOD` to `manual` and `ingestManualBucketName` to `rfcx-guardian-ark-staging` in the environment variables (.env). Also add the AWS S3 user config: `S3_ACCESS_KEY_ID`, `S3_SECRET_KEY`, `S3_REGION_ID`.

3. Streams endpoint - not yet implemented

Set the `INGEST_METHOD` to `streams` in the environment variables (.env).
