# Stage 1: turn the CSVs into the JSON the app loads.
FROM python:3.12-alpine AS data
WORKDIR /build
COPY tools/build_data.py tools/
COPY data/ data/
RUN python3 tools/build_data.py data out && cp data/*.csv out/

# Stage 2: static site served by nginx.
FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/40-oujda-config.sh /docker-entrypoint.d/40-oujda-config.sh
COPY web/ /usr/share/nginx/html/
COPY --from=data /build/out/ /usr/share/nginx/html/data/
# Strip Windows line endings (a CRLF checkout breaks the script's shebang).
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-oujda-config.sh \
    && chmod +x /docker-entrypoint.d/40-oujda-config.sh \
    && chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
