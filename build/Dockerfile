FROM node:20.9.0 as base

RUN apt update && apt install -y sox libsox-fmt-mp3 pngcrush imagemagick ffmpeg

WORKDIR /tmp
RUN rm -rf /var/lib/apt/lists/* && \
    rm -rf /tmp/*

# RUN ln -s /usr/lib/aarch64-linux-gnu/libssl.so.3 /usr/lib/aarch64-linux-gnu/libssl.so.10
# RUN ln -s /usr/lib/aarch64-linux-gnu/libcrypto.so.3 /usr/lib/aarch64-linux-gnu/libcrypto.so.10

ENV SOX_PATH="/usr/bin/sox"
ENV FFMPEG_PATH="/usr/bin/ffmpeg"
ENV IMAGEMAGICK_PATH="/usr/bin/convert"
ENV PNGCRUSH_PATH="/usr/bin/pngcrush"
ENV CACHE_DIRECTORY="/tmp/ingest-service/"

# -- Application build --
FROM base as ingest-service

# Dependencies
WORKDIR /app
ADD . /app/
RUN yarn --frozen-lockfile
CMD yarn start
