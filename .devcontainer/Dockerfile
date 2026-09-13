FROM mcr.microsoft.com/devcontainers/javascript-node:5.2.1-24-bookworm

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.19.0 @openai/codex@0.154.0
USER node
