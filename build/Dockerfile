FROM ubuntu:18.04 as base
RUN apt update \
    && apt install -y \
        curl \
        gnupg \
        gcc \
        g++ \
        make \
        sox \
        pngcrush \
        imagemagick \
        python-minimal \
        software-properties-common \
        libsox-fmt-all
RUN add-apt-repository ppa:jonathonf/ffmpeg-4 && \
    apt install -y  ffmpeg libsox-fmt-all && \
    mkdir -p /var/app/ && \
    curl -sL https://deb.nodesource.com/setup_16.x | bash - && \
    apt update && \
    apt install -y nodejs && \
    rm -rf /var/lib/apt/lists/*
ENV CACHE_DIRECTORY="/tmp/ingest-service/"
RUN mkdir /tmp/ingest-service

# -- Builder

FROM node:20.9.0 as builder
RUN mkdir /var/app
ADD . /var/app/
WORKDIR /var/app
RUN npm install

# -- Target

FROM base as ingest-service
COPY --from=builder /var/app/ /var/app/
WORKDIR /var/app
CMD npm start
