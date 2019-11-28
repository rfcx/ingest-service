FROM node:12 as builder

RUN mkdir /var/app
ADD . /var/app/
WORKDIR /var/app/functions
RUN npm install

FROM 887044485231.dkr.ecr.eu-west-1.amazonaws.com/node12_base:latest 

COPY --from=builder /var/app/ /var/app/
WORKDIR /var/app/functions
CMD npm run start.amazon