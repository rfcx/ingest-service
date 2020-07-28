# Jenkinsfile 

At the current stage, Jenkins does both CI and CD functions. However, we are working on getting our CI/CD pipeline more professional by using Jenkins with CI, Unit tests, static files check..etc and Spinnaker for the CD functions.

Jenkinsfile contains three main stages

* Building and pushing the Docker image to ECR
* Deploying the newely built image to the proper namespace in Kubernetes
* Verifying the deployment

Stages are pretty clear in Jenkinsfile, what I want to clarify more here is how to add new CI/CD for a new branch

## Requirements

* Having full access to Kubernetes cluster
* Having full access to ECR
* Create the new branch on GitHub
* Edit all mainifest files:
    - Set the proper `IMAGE_URL` in `deployment.yaml` file
    - Set the proper `DOMAIN` in `ingress.yaml`
    - Set the proper `NAMESPACE` in `auto-scaler.yaml`
* Apply k8s manifest files with the following command inside k8s directory:

```
kubectl -n NAMESPACE apply -k ./
```
* Create ECR repository with a proper name. For example, for testing environment, repository name should be `ingest-service/testing`, for staging `ingest-servicer/staging` ..etc
* Edit Jenkinsfile with new branch name to be considered in the CI/CD pipeline
* Push Jenkinsfile edits

Note: 

1. It is very important to ensure that NAMESPACE in the above command matches the branch name. Also, we have 3 environments "at the moment of writing this README": 
* testing
* staging
* production

2. If you want to create CI/CD for a branch/environment that is not in the above list, you have to create a new namespace first in k8s with the following command:
```
kubectl create ns NAMESPACE_NAME
```

## Building the image

In order to build this Docker image, you have to get access to RFCx ECR first, please contact DevOps team to grant you proper access level

```
aws ecr get-login --no-include-email --region eu-west-1 | bash
docker build -t ingest-service .
```
