# PiVoice for Raspberry Pi 4 (arm64). Build on the Pi or with buildx for linux/arm64.
FROM node:24-bookworm-slim

# ffmpeg does capture (ALSA) and radio encoding; alsa-utils gives `arecord -l` for device discovery.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg alsa-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm install --no-save --package-lock=false onnxruntime-node
COPY scripts/download-silero-model.js ./scripts/download-silero-model.js
RUN node scripts/download-silero-model.js
COPY src ./src
COPY cli ./cli
COPY openapi ./openapi

ENV NODE_ENV=production \
    PIVOICE_HOST=0.0.0.0 \
    PIVOICE_PORT=8095 \
    PIVOICE_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8095
USER node
CMD ["node", "src/main.js"]
