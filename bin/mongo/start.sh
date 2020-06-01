#!/usr/bin/env bash

docker volume create mongo_data

docker run --rm --name ingest-service-mongo -p 27017:27017 -v mongo_data:/data/db \
  -e MONGO_INITDB_ROOT_USERNAME=admin-user \
  -e MONGO_INITDB_ROOT_PASSWORD=test \
  -d mongo:4.2.5
