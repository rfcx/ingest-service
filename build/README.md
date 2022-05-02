# Deployment YAML file

GitHub Actions deploys the ingest service. It contains four main stages:

* Building and pushing the Docker image to ECR
* Applying k8s manifest files
* Deploying the newly built image to the proper namespace in Kubernetes
* Verifying the deployment

Each directory inside k8s directory refers to an existing enviornment already, if you want to modify an existing environment like adjusting resources' reqestes or limits, all you have to do is to push a change in `deployment.yaml` to the repo and Jenkins will apply those changes

# CAUTION
Changing any manifest files should be tested as GitHub Actions will apply those changes with an extremely aggressive way, which might cause a downtime to production environment

# Externalmetrics YAML file
`externalmetrics.yaml` file is responsible for communicating with AWS adapter (previously installed on k8s) to get a specific SQS queue metrics, please edit this file to set SQS queue name, how frequently we should get metrics and metric name...etc

# HPA YAML file
`hpa.yaml` is responsible for adjusting the desired capacity based on the gatherd metrics by external metrics, please edit this file to set minimum running pods, maximum running pods and when should we scale up and down

## Requirements

* Having full access to Kubernetes cluster
* Having full access to ECR
* Create the new branch on GitHub
* Edit all mainifest files:
    - Set the proper `IMAGE_URL` in `deployment.yaml` file
    - Set the proper `DOMAIN` in `ingress.yaml`
    - Set the proper `NAMESPACE` in `auto-scaler.yaml`
* Apply k8s manifest files with the following command inside build directory:

```
kubectl -n NAMESPACE apply -f ./testing
```

## Building the image

In order to build this Docker image, you have to get access to RFCx ECR first, please contact DevOps team to grant you proper access level

```
aws ecr get-login --no-include-email --region eu-west-1 | bash
docker build -t ingest-service .
```
