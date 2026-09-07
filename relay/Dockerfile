# Works as-is on Fly.io, Railway, Render, Koyeb, or any Docker host.
FROM node:22-alpine

WORKDIR /app
COPY package.json server.mjs ./

# Bind to all interfaces so the platform's router can reach it. The server
# refuses to start on a public interface unless TOKEN is set, so set TOKEN
# in your host's environment/secrets.
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# No dependencies to install - the relay is stdlib-only.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.mjs"]
