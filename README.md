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

Copy `functions/.env.example` to `functions/.env`. Minimum setup requires `PLATFORM`, `API_HOST`, `UPLOAD_BUCKET` (follow the instructions for other vars).

Install dependencies:
```
cd functions
npm install
```

### For Amazon

Run the API endpoints:
```
npm run start.amazon
```

### For Google

Cloud Functions use envrionment variables from .runtimeconfig.json. To generate this file from your .env file:
```
node devtools/convertEnvToFirebaseConfig.js
```

Run the API endpoints only:
```
npm run servefb
```

Test the cloud functions that trigger on new storage objects (and also run the API endpoints):
```
npm run shellfb
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

Before deploying the functions, upload the config to the server:
```
npm run deployfbconfig
```
Note that config can be updated independently of the code in the functions.

Deploy to Firebase Cloud Functions:
```
npm run deployfb
```

To set the CORS on GCS (to enable the ingest app to PUT a file):
```
gsutil cors set storage.cors.json gs://rfcx-ingest-dev.appspot.com
```

## Testing

The `example` folder contains `upload.js` which can be run as `node upload.js filename.mp3` to perform the client-side steps to upload the file (get a signed url, upload the file to storage, and check the upload status). (Install the dependencies before you start `cd example ; npm i`.)

To test the trigger from storage, use the `npm run shellfb` described above (from the `functions` folder).


## Ingestion methods

1. Checkin endpoint

Set the `INGEST_METHOD` to `checkin` in rfcxConfig.json. No extra configuration required.

2. Manual S3 upload and audio endpoint

Set the `INGEST_METHOD` to `manual` and `ingestManualBucketName` to `rfcx-guardian-ark-staging` in rfcxConfig.json. Also add the AWS S3 user config: `S3_ACCESS_KEY_ID`, `S3_SECRET_KEY`, `S3_REGION_ID`.

3. Streams endpoint - not yet implemented

Set the `INGEST_METHOD` to `streams` in rfcxConfig.json. 


## Not yet implemented

- *Authentication*: Currently need to set an access token with the guardianCreator role in `.env` under `TEMP_ACCESS_TOKEN`. In future, we need to pass the access token from the client (Ingest App).
