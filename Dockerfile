# syntax=docker/dockerfile:1.7
#
# The official Infall Team server image (docs/specs/team-move.md, decision 8; deploy/README.md).
#
#   docker buildx build -t infall:dev .                                   # this computer's kind
#   docker buildx build --platform linux/amd64,linux/arm64 -t … .        # both (see image.yml)
#
# Three stages: the web UI (Node.js; its output is the same on every processor, so it is built
# once on the build machine's own kind), the server (Rust, built for the target processor) and
# a small Debian runtime with the binary, the UI, sqlite3 for backups and the entrypoint.
# No secret is ever part of the image: the secret key comes from the environment or is made in
# the data volume on first start (deploy/container/entrypoint.sh).

ARG RUST_VERSION=1.96.0
ARG NODE_IMAGE=node:22-bookworm-slim
ARG DEBIAN_RELEASE=trixie

# ---- web UI -------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- server -------------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-slim-${DEBIAN_RELEASE} AS server
ARG TARGETARCH
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# The registry and the target folder are cache mounts: a rebuild after a source change
# compiles only what changed, and neither ends up in an image layer.
RUN --mount=type=cache,id=infall-cargo-registry-${TARGETARCH},target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=infall-cargo-target-${TARGETARCH},target=/src/target,sharing=locked \
    cargo build --release --locked -p qoop-server \
    && install -m 755 target/release/qoop-server /qoop-server

# ---- runtime ------------------------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim
ARG INFALL_VERSION=dev

# sqlite3: consistent copies for backups and before upgrades. ca-certificates: the two
# outgoing HTTPS calls a Member can trigger (OpenRouter, Look up; docs/privacy.md).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 infall \
    && useradd --uid 10001 --gid infall --home-dir /data --no-create-home --no-log-init \
       --shell /usr/sbin/nologin infall \
    && install -d -o infall -g infall -m 700 /data /backups

COPY --from=server /qoop-server /usr/local/bin/qoop-server
COPY --from=web /src/web/dist /app/web
COPY --chmod=755 deploy/container/entrypoint.sh /usr/local/bin/infall

ENV QOOP_ADDR=0.0.0.0:8787 \
    QOOP_DB=/data/qoop.db \
    QOOP_WEB_DIR=/app/web \
    QOOP_PUBLIC_ORIGIN=http://localhost:8787 \
    INFALL_VERSION=${INFALL_VERSION}

LABEL org.opencontainers.image.title="Infall server" \
      org.opencontainers.image.description="The Infall Team server: one Team Workspace for several Members" \
      org.opencontainers.image.version="${INFALL_VERSION}"

USER infall:infall
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["infall", "health"]
ENTRYPOINT ["infall"]
CMD ["serve"]
