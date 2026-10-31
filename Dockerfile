FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3002 \
    DATA_DIR=/app/data

WORKDIR /app

# No npm dependencies: the server only uses Node's standard library.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Belt and braces: strip any Windows CRLF from the startup script, even if the
# build context came from a Windows checkout that ignored .gitattributes.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
