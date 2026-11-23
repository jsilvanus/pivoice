# pivoice-translate-worker: an fffleet worker that claims job type `translate` (fleet/translate/executor.js)
# and translates caption segments with OPUS-MT models on the CPU (marian-onnx engine, plan §7).
# No model weights in the image: mount a directory filled by fleet/translate/scripts/fetch-models.mjs at
# /models (read-only). At start the entrypoint loads every model in /models/models.json once and advertises
# translate:<src>-<tgt> for those that passed.
# Build from the repository root:  docker build -f docker/translate-worker.Dockerfile -t pivoice-translate-worker .
FROM node:24-bookworm-slim AS build
WORKDIR /app/fleet/translate
RUN corepack enable
COPY fleet/translate/package.json fleet/translate/pnpm-lock.yaml fleet/translate/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
# The fffleet worker daemon (same version line as the fffleet client PiVoice uses).
RUN mkdir /opt/fffleet-worker && cd /opt/fffleet-worker \
 && npm init -y >/dev/null && npm install --omit=dev --ignore-scripts fffleet-worker@2.8.0 && npm cache clean --force

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /opt/fffleet-worker /opt/fffleet-worker
COPY --from=build /app/fleet/translate/node_modules fleet/translate/node_modules
COPY fleet/translate/package.json fleet/translate/*.js fleet/translate/*.mjs fleet/translate/
COPY fleet/translate/engines fleet/translate/engines
COPY fleet/translate/scripts fleet/translate/scripts
COPY fleet/translate/test fleet/translate/test
# The executor and the fetch script share PiVoice's language policy (no dependencies).
COPY src/translation/policy.js src/translation/policy.js
RUN mkdir -p /var/lib/fffleet /models && chown node:node /var/lib/fffleet
USER node
ENV NODE_ENV=production \
    PORT=5100 \
    HOST=0.0.0.0 \
    FFFLEET_WORK_DIR=/var/lib/fffleet \
    FFFLEET_WORKER_BIN=/opt/fffleet-worker/node_modules/.bin/fffleet-worker \
    TRANSLATE_MODEL_DIR=/models \
    TRANSLATE_THREADS=2 \
    TRANSLATE_MAX_LOADED=3
EXPOSE 5100
HEALTHCHECK --interval=15s --timeout=3s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/fleet/translate/entrypoint.mjs"]
