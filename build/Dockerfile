FROM node:20.9.0 as base

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
        ffmpeg

ENV SOX_PATH="/usr/bin/sox"
ENV FFMPEG_PATH="/usr/bin/ffmpeg"
ENV IMAGEMAGICK_PATH="/usr/bin/convert"
ENV PNGCRUSH_PATH="/usr/bin/pngcrush"
ENV CACHE_DIRECTORY="/tmp/ingest-service/"
RUN mkdir /tmp/ingest-service

# -- Application build --
FROM base as build

# Dependencies
WORKDIR /app
COPY package.json yarn.lock /app/
RUN yarn --production --frozen-lockfile

# Target
FROM build as ingest-service
EXPOSE 80
CMD ["yarn", "start"]
