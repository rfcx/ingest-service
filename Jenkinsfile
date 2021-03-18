pipeline {
    agent {
    kubernetes {
      yaml """
kind: Pod
metadata:
  name: kaniko
spec:
  containers:
  - name: kaniko
    image: gcr.io/kaniko-project/executor:debug
    imagePullPolicy: Always
    command:
    - cat
    tty: true
    volumeMounts:
      - name: docker-config
        mountPath: /kaniko/.docker
  volumes:
    - name: docker-config
      configMap:
        name: docker-config
"""
    }
  }
    environment {
        APP = "ingest-service"
        PHASE = branchToConfig(BRANCH_NAME)
        ECR = "887044485231.dkr.ecr.eu-west-1.amazonaws.com"
    }

    stages {

        stage("Build") {
            when {
                 expression { BRANCH_NAME ==~ /(master|staging)/ }
            }
            steps {
                slackSend (channel: "#${slackChannel}", color: '#FF9800', message: "*Ingest Service*: Build started <${env.BUILD_URL}|#${env.BUILD_NUMBER}> commit ${env.GIT_COMMIT[0..6]} branch ${env.BRANCH_NAME}")
                catchError {
                container(name: 'kaniko') {
                sh '''
                /kaniko/executor --snapshotMode=redo --use-new-run=true --cache=true --build-arg PHASE=${PHASE} --build-arg --cache-repo=${ECR}/${APP}/${PHASE} --dockerfile `pwd`/Dockerfile --context `pwd` --destination=${ECR}/${APP}/${PHASE}:latest --destination=${ECR}/${APP}/${PHASE}:${GIT_COMMIT} --destination=${ECR}/${APP}/${PHASE}:v$BUILD_NUMBER
                '''
                }
                }
            }

           post {
               success {
                   slackSend (channel: "#${slackChannel}", color: '#3380C7', message: "*Ingest Service*: Image built on <${env.BUILD_URL}|#${env.BUILD_NUMBER}> branch ${env.BRANCH_NAME}")
                   echo 'Compile Stage Successful'
               }
               failure {
                   slackSend (channel: "#${slackChannel}", color: '#F44336', message: "*Ingest Service*: Image build failed <${env.BUILD_URL}|#${env.BUILD_NUMBER}> branch ${env.BRANCH_NAME}")
                   echo 'Compile Stage Failed'
               }

           }
        }
        stage('Deploy') {
            agent {
                label 'slave'
            }
            when {
                 expression { BRANCH_NAME ==~ /(master|staging)/ }
            }
            steps {
                sh "kubectl -n ${PHASE} apply -f build/k8s/${PHASE}"
                sh "kubectl set image deployment ${APP} ${APP}=${ECR}/${APP}/${PHASE}:v$BUILD_NUMBER --namespace ${PHASE}"
            }

        }
        stage('Verifying') {
            agent {
                label 'slave'
            }
            options {
                skipDefaultCheckout true
            }
            when {
                 expression { BRANCH_NAME ==~ /(master|staging)/ }
            }
            steps {
            catchError {
            sh "kubectl rollout status deployment ${APP} --namespace ${PHASE}"
            slackSend (channel: "#${slackChannel}", color: '#4CAF50', message: "*Ingest Service*: Deployment completed <${env.BUILD_URL}|#${env.BUILD_NUMBER}> branch ${env.BRANCH_NAME}")
            }
            }

        }
    }
    post {
        success {
            echo 'whole pipeline successful'
                }
        unstable {
            echo 'pipeline failed, at least one step unstable'
                    
            }
        failure {
            echo 'I failed :('
        }
    }
}


  def branchToConfig(branch) {
     script {
        result = "NULL"
        if (branch == 'staging') {
             result = "staging"
        slackChannel = "alerts-deployment"
        withCredentials([file(credentialsId: 'ingest_staging_env', variable: 'PRIVATE_ENV')]) {
        sh "chmod -R 777 *"
        sh "cp $PRIVATE_ENV functions/.env"
        sh "chmod 777 functions/.env"
        }
        }
        if (branch == 'master') {
             result = "production"
        slackChannel = "alerts-deployment-prod"
        withCredentials([file(credentialsId: 'ingest_production_env', variable: 'PRIVATE_ENV')]) {
        sh "chmod -R 777 *"
        sh "cp $PRIVATE_ENV functions/.env"
        sh "chmod 777 functions/.env"
        }
         }
         echo "BRANCH:${branch} -> CONFIGURATION:${result}"
       
         }
         return result
     }
