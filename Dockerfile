FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    procps hostname curl git openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /data/workspace

# Copy workspace identity files
COPY IDENTITY.md SOUL.md USER.md AGENTS.md TOOLS.md HEARTBEAT.md ./
COPY memory ./memory/
COPY skills ./skills/

CMD ["echo", "Workspace files synced"]
