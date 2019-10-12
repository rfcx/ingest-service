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

Install dependencies:
```
cd functions
npm install
```

Run the API endpoints:
```
npm run serve
```

Test the cloud functions that trigger on new storage objects:
```
npm run shell
```

then emulate a new object added to the bucket:
```
ingest({name:'uploaded/stream1/EP2HdN7NnsTR173f8Syh.wav', contentType: 'audio/wav'})
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
