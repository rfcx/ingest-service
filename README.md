# Ingest Service

API for ingesting files from RFCx Uploader and other clients.


## Requirements

- Node 10.x.x
- Docker (to run a local MongoDB)
- [FFmpeg](https://ffmpeg.org) for splitting and identifying audio files

Optional:
- [ES Lint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) for VS Code

### Good to know

The ingest service uses the following services in `google` mode:
- [Firestore](https://cloud.google.com/firestore/) for storing upload metadata
- [Pub/Sub](https://cloud.google.com/pubsub/) for receiving notifications about new ingestions
- [Cloud Storage](https://cloud.google.com/storage/) for audio files downloading and uploading

And these services in `amazon` mode:
- [MongoDB](https://www.mongodb.com/) for storing upload metadata
- [Amazon SQS](https://aws.amazon.com/sqs/) for receiving notifications about new ingestions
- [Amazon S3](https://aws.amazon.com/s3/) for audio files downloading and uploading


## Local development

1. Copy `.env.example` to `.env`. Set the AWS and Auth0 keys as a minimum.

2. Install dependencies.
   ```
   npm install
   ```

3. Start MongoDB using Docker.
   ```
   npm run start.mongo
   ```
   MongoDB will start on `localhost` with port `27017`, db name `admin`, user `admin-user`, and password `test`.

   (When you want to stop MongoDB, use:)
   ```
   npm run stop.mongo
   ```

4. Start the API (with live reloading).
   ```
   npm run dev
   ```

   In production the API endpoints are run directly:
   ```
   npm start
   ```

5. Open [localhost:3030/docs](http://localhost:3030/docs) to test the endpoints.


Use these [instructions](https://confluence.rfcx.org/display/RD/Configuring+S3+new+file+trigger+to+SQS+queue "Confluence document") to configure S3 new file trigger to SQS queue.

_TODO - How to run the background job (SQS Consumer) and test the triggers from S3 to ingest?_


## Lint

The project uses ES Lint. Use `npm run lint` to check for errors or `npm run lint-fix` to attempt to auto-fix the errors.

VS Code support for lint is via the [ES Lint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint).


## Testing

_TODO - this doesn't look like it works anymore_

The `example` folder contains `upload.js` which can be run as `node upload.js filename.mp3` to perform the client-side steps to upload the file (get a signed url, upload the file to storage, and check the upload status). (Install the dependencies before you start `cd example ; npm i`.)

To test the trigger from storage, use the `npm run shellfb` described above.


## Ingestion methods

_TODO - probably not relevant now (always use `stream`)_

1. Checkin endpoint

Set the `INGEST_METHOD` to `checkin` in the environment variables (.env). No extra configuration required.

2. Manual S3 upload and audio endpoint

Set the `INGEST_METHOD` to `manual` and `ingestManualBucketName` to `rfcx-guardian-ark-staging` in the environment variables (.env). Also add the AWS S3 user config: `S3_ACCESS_KEY_ID`, `S3_SECRET_KEY`, `S3_REGION_ID`.

3. Streams endpoint - not yet implemented

Set the `INGEST_METHOD` to `stream` in the environment variables (.env).


## Auto-update endpoints

_TODO - needs further explanation: what needs to be setup on Github? why are we using a fork of Nuts?_

The ingest service can expose endpoints for auto-updating the client application (RFCx Uploader). It uses [Nuts](https://nuts.gitbook.com).
