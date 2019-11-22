# Ingest Service

A mockup service for ingesting files via GCS


## Requirements

- Node 8+
- [Google Cloud SDK](https://cloud.google.com/sdk/)
- [Firebase CLI](https://firebase.google.com/docs/cli)


## Setup project

Create a Google Cloud project (e.g. `rfcx-ingest-dev`) -- preferably attached to the RFCx organization.

Go to [Firebase console](https://console.firebase.google.com/) and create project for the Google Cloud project. Enable `Firestore` and `Storage` from the console.

Get a Service Account key for the Google Cloud project with roles: `Storage Object Creator`, `Storage Object Viewer`.
```
gcloud beta iam service-accounts create functions-storage --project rfcx-ingest-dev \
    --description "Upload and download GCS files from CF" \
    --display-name "Functions to Storage"
gcloud projects add-iam-policy-binding rfcx-ingest-dev \
  --member serviceAccount:functions-storage@rfcx-ingest-dev.iam.gserviceaccount.com \
  --role roles/storage.objectViewer
gcloud projects add-iam-policy-binding rfcx-ingest-dev \
  --member serviceAccount:functions-storage@rfcx-ingest-dev.iam.gserviceaccount.com \
  --role roles/storage.objectCreator
gcloud iam service-accounts keys create functions/serviceAccountKeyStorage.json \
  --iam-account functions-storage@rfcx-ingest-dev.iam.gserviceaccount.com --project rfcx-ingest-dev
```

## Local development

_Temporary step for demo:_
Copy `services/rfcxConfig.json.example` to `services/rfcxConfig.json` and set the API base url and access token (see "Not yet implemented" below).

Install dependencies:
```
cd functions
npm install
```

Run the API endpoints only:
```
npm run serve
```

Test the cloud functions that trigger on new storage objects (and also run the API endpoints):
```
npm run shell
```

then emulate a new object added to the bucket:
```
uploaded({name:'uploaded/test/9hSBSHakAw8gjT7Pz6pe.mp3', contentType: 'audio/mp3'})
```

and trigger the next ingest:
```
ingest()
```


## Deployment

Deploy to Firebase Cloud Functions:
```
npm run deploy
```

To set the CORS on GCS (to enable the ingest app to PUT a file):
```
gsutil cors set storage.cors.json gs://rfcx-ingest-dev.appspot.com
```

## Testing

The `example` folder contains `upload.js` which can be run as `node upload.js filename.mp3` to perform the client-side steps to upload the file (get a signed url, upload the file to storage, and check the upload status). (Install the dependencies before you start `cd example ; npm i`.)

To test the trigger from storage, use the `npm run shell` described above (from the `functions` folder).


## Ingestion methods

1. Checkin endpoint

Set the `ingestMethod` to `checkin` in rfcxConfig.json. No extra configuration required.

2. Manual S3 upload and audio endpoint

Set the `ingestMethod` to `manual` and `ingestManualBucketName` to `rfcx-guardian-ark-staging` in rfcxConfig.json. Also add the AWS S3 user config: `s3AccessKey`, `s3PrivateKey`, `s3Region`.

3. Streams endpoint - not yet implemented

Set the `ingestMethod` to `streams` in rfcxConfig.json. 


## Not yet implemented

- *Authentication*: Currently need to set an access token with the guardianCreator role in `services/rfcxConfig.json` under `tempAccessToken`. In future, we need to pass the access token from the client (Ingest App).
