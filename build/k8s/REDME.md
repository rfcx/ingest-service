# Deployment YAML file

At the current stage, Jenkins does both CI and CD functions. We are working on getting our CI/CD pipeline more professional by using Jenkins with CI, Unit tests, static files check..etc and Spinnaker for the CD functions.

Jenkinsfile contains four main stages

* Building and pushing the Docker image to ECR
* Applying k8s manifest files
* Deploying the newely built image to the proper namespace in Kubernetes
* Verifying the deployment

Each directory inside k8s directory refers to an existing enviornment already, if you want to modify an existing environment like adjusting resources' reqestes or limits, all you have to do is to push a change in `deployment.yaml` to the repo and Jenkins will apply those changes

# CAUTION
Changing any manifest files should be tested very well as Jenkins will apply those changes with an extremely aggressive way, which might cause a downtime to production environment

# Externalmetrics YAML file
`externalmetrics.yaml` file is responsible for communicating with AWS adapter (previously installed on k8s) to get a specific SQS queue metrics, please edit this file to set SQS queue name, how frequently we should get metrics and metric name...etc

# HPA YAML file
`hpa.yaml` is responsible for adjusting the desired capacity based on the gatherd metrics by external metrics, please edit this file to set minimum running pods, maximum running pods and when should we scale up and down

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
