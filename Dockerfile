# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --offline

FROM node:24-bookworm-slim AS beads
ARG BEADS_VERSION=1.3.1
ARG TARGETARCH
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --prefix /tmp/downloader undici
# Fetch through HTTP_PROXY/HTTPS_PROXY when set; verify the release checksum.
COPY scripts/download-beads.mjs /tmp/download-beads.mjs
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    node /tmp/download-beads.mjs "$BEADS_VERSION" "$TARGETARCH" && \
    mkdir /out && tar -xzf /tmp/beads.tar.gz -C /out bd

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build --chown=node:node --chmod=644 /app/package.json ./package.json
COPY --chown=node:node skills ./skills
COPY --from=beads /out/bd /usr/local/bin/bd
COPY --chmod=755 scripts/entrypoint.sh /app/entrypoint.sh
RUN test -s /app/skills/beads-engineering-backlog/SKILL.md && \
    mkdir -p /data/project && chown -R node:node /data
ENV NODE_ENV=production BEADS_PROJECT_DIR=/data/project BEADS_DIR=/data/project/.beads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e 'fetch("http://127.0.0.1:3000/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/index.js"]
