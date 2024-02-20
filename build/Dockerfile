FROM ubuntu:22.04 as base
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
        libsox-fmt-all \
        ffmpeg \
        libssl3

RUN apt update \
    && apt install -y git

RUN mkdir -p /var/app/
RUN rm -rf /var/lib/apt/lists/*

ENV SOX_PATH="/usr/bin/sox"
ENV FFMPEG_PATH="/usr/bin/ffmpeg"
ENV IMAGEMAGICK_PATH="/usr/bin/convert"
ENV PNGCRUSH_PATH="/usr/bin/pngcrush"
ENV CACHE_DIRECTORY="/tmp/ingest-service/"
RUN mkdir /tmp/ingest-service

# -- Install NVM
ENV NVM_DIR /usr/local/nvm
ENV NODE_VERSION v20.9.0
RUN mkdir -p /usr/local/nvm && apt-get update && echo "y" | apt-get install curl
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
RUN /bin/bash -c "source $NVM_DIR/nvm.sh && nvm install $NODE_VERSION && nvm use --delete-prefix $NODE_VERSION"
ENV NODE_PATH $NVM_DIR/versions/node/$NODE_VERSION/bin
ENV PATH $NODE_PATH:$PATH
RUN npm install -g yarn

# -- Target
FROM base as ingest-service
ADD . /var/app/
WORKDIR /var/app
RUN yarn --frozen-lockfile
CMD yarn start
