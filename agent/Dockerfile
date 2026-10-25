# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    LOG_DIR=/npm-logs \
    STATE_FILE=/state/offsets.json
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /state && chown -R node:node /app /state
USER node
VOLUME ["/state"]
# The agent only reads logs and talks to the hub; it listens on 8099 for health checks.
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8099/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/agent.js"]
