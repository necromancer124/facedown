# Runs the facedown MCP server in a container, so directories such as Glama
# can start it and list its tools. Not needed for normal use: facedown runs
# directly with Node on your own computer (`npx facedown mcp`).
#
# In a container there are no password or confirmation windows, so anything
# that needs your approval (adding a key, allowing a site) is refused there.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV FACEDOWN_NO_WINDOW=1 \
    FACEDOWN_NO_UPDATE_CHECK=1 \
    FACEDOWN_DIR=/data \
    FACEDOWN_HOME=/data/.facedown

RUN mkdir -p /data && chown node:node /data
USER node

ENTRYPOINT ["node", "src/cli.js", "mcp"]
