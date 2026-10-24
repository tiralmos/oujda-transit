# Stage 1: turn the CSVs into the JSON the app loads, then give every asset
# URL a content version so browsers and proxies never serve stale files.
FROM python:3.12-alpine AS build
WORKDIR /build
COPY tools/build_data.py tools/stamp_assets.py tools/
COPY data/ data/
COPY web/ site/
RUN python3 tools/build_data.py data site/data \
    && cp data/*.csv site/data/ \
    && python3 tools/stamp_assets.py site

# Stage 2: static site served by nginx.
FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf && mkdir -p /etc/nginx/oujda
COPY docker/nginx.conf /etc/nginx/conf.d/oujda-transit.conf
COPY docker/40-oujda-config.sh /docker-entrypoint.d/40-oujda-config.sh
COPY --from=build /build/site/ /usr/share/nginx/html/
# Strip Windows line endings (a CRLF checkout breaks the script's shebang).
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-oujda-config.sh \
    && chmod +x /docker-entrypoint.d/40-oujda-config.sh \
    && chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
