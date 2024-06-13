<a name="1.1.1"></a>
## 1.1.1 (2024-06-xx)

### Bug Fixes
* Not include very small segments to Core API

<a name="1.1.0"></a>
## 1.1.0 (2024-02-xx)

### Features
* Upgrade node to LTS and use yarn
* Add `duration`, `fileSize` to `GET /uploads` params.
* Deny upload with `timestamp` is future
* Deny upload with `timestamp` is past older than year 1971
* Deny upload with `duration` is more than 1 hour
* Deny upload with `fileSize` is more than 150MB for flac and 200MB for wav

<a name="1.0.10"></a>
## 1.0.10 (2024-01-xx)

### Features
* Deny flac and wav files with a specific size to avoid too big file ingestion
* Deny files with duration more than 1 hour

<a name="1.0.9"></a>
## 1.0.9 (2022-07-29)

### Bug Fixes
* Fix max processing segments by ffmpeg ([#77](https://github.com/rfcx/engineering-support/issues/77))

### Performance Improvements
* Upload splitted segments 5 files at a time ([#77](https://github.com/rfcx/engineering-support/issues/77))

<a name="1.0.8"></a>
## 1.0.8 (2021-09-06)

### Features
* Parse sample rate from guardian audio filename ([CE-1264](https://jira.rfcx.org/browse/CE-1264))

<a name="1.0.7"></a>
## 1.0.7 (2021-08-05)

### Features
* Add user permissions into get projects endpoint ([CE-1175](https://jira.rfcx.org/browse/CE-1175))

<a name="1.0.6"></a>
## 1.0.6 (2021-08-03)

### Bug Fixes
* Check user permissions for stream before creating an upload ([CE-831](https://jira.rfcx.org/browse/CE-831))

### Other
* Refactor routes code: call middleware from root; delete Auth0 roles checks
* Refactor app structure; delete firebase-releated stuff
* Request only streams for which user has update permission ([CE-831](https://jira.rfcx.org/browse/CE-831))
* Add pull_request Gihub action which checks lint errors
* Add integration tests for uploads routes

<a name="1.0.5"></a>
## 1.0.5 (2021-05-26)

### Features
* Update split logic: break into 60 secs if file >= 120 secs; if less 120 secs, do nothing ([CE-244](https://jira.rfcx.org/browse/CE-244))
* Add project endpoints ([CE-764](https://jira.rfcx.org/browse/CE-764))

 <a name="1.0.4"></a>
## 1.0.4 (2021-04-27)

### Features
* Save ingested error files to error directory ([PI-670](https://jira.rfcx.org/browse/PI-670))

### Performance Improvements
* Refactor ingestion code to be shorter and simpler ([CE-469](https://jira.rfcx.org/browse/CE-469))

### Bug Fixes
* Use one endpoint for stream_source_file and stream_segment creation ([CE-469](https://jira.rfcx.org/browse/CE-469))
* Request stream info after creation

### Other
* Move recordings creation to Core API side

<a name="1.0.3"></a>
## 1.0.3 (2021-03-15)

### Features
* Add GET /deployments endpoint ([CE-236](https://jira.rfcx.org/browse/CE-236))


<a name="1.0.2"></a>
## 1.0.2 (2021-03-02)

### Features
* Delete arbimon site creation from stream creation endpoint ([CE-174](https://jira.rfcx.org/browse/CE-174))


<a name="1.0.1"></a>
## 1.0.1 (2021-02-25)

### Features
* Check for duplicate source file before creating the upload ([CE-31](https://jira.rfcx.org/browse/CE-31))
* Refactor all streams and uploads endpoints to use async and rfcx/http-utils module ([CE-31](https://jira.rfcx.org/browse/CE-31))
* Update GET deployment info endpoint to call Device API ([CE-35](https://jira.rfcx.org/browse/CE-35))

### Features
* Delete unused user-related endpoints
* Delete unused deployments-related endpoints


<a name="1.0.0"></a>
## 1.0.0 (2021-02-25)

### Bug Fixes
* setup release process ([CE-XXX](https://jira.rfcx.org/browse/CE-XXX))

### Features
* setup release process ([CE-XXX](https://jira.rfcx.org/browse/CE-XXX))

### Performance Improvements
* setup release process ([CE-XXX](https://jira.rfcx.org/browse/CE-XXX))
