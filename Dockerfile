# Production image: the built frontend + the pinned PocketBase, nothing else. Used by Dokku (README "Deploying").

# ---- frontend: web/ → pb_public/ ----
FROM node:22-alpine AS web
# npm 10 (bundled with Node 22) crashes resolving this lockfile; package.json asks for npm ≥ 11.
RUN npm install -g npm@11
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts scripts
COPY web web
RUN npm run build

# ---- pocketbase: the pinned, checksum-verified binary ----
FROM alpine:3.22 AS pocketbase
RUN apk add --no-cache curl
WORKDIR /src
COPY scripts/fetch-pocketbase.sh scripts/
RUN sh scripts/fetch-pocketbase.sh

# ---- runtime ----
FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
  && adduser -D -H -u 32767 chat \
  && mkdir /pb_data && chown chat /pb_data
WORKDIR /app
COPY --from=pocketbase /src/bin/pocketbase ./pocketbase
COPY --from=web /src/pb_public ./pb_public
COPY pb_migrations ./pb_migrations
COPY pb_hooks ./pb_hooks
USER chat
# All data (SQLite + uploaded files) lives here: mount persistent storage on it.
VOLUME /pb_data
EXPOSE 8090
CMD ["/app/pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/pb_data", "--publicDir=/app/pb_public", "--migrationsDir=/app/pb_migrations", "--hooksDir=/app/pb_hooks"]
