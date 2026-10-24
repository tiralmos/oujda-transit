#!/bin/sh
# Writes config.js and the address-search proxy from environment variables
# when the container starts.
set -eu

target=/usr/share/nginx/html/config.js
geocoder_conf=/etc/nginx/oujda/geocoder.conf

# Escape a value for use inside a double-quoted JavaScript string.
js_string() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's#</#<\\/#g' | tr -d '\r\n'
}

fail() {
    echo "oujda-transit: $*" >&2
    exit 1
}

tile_url=${TILE_URL:-'https://tile.openstreetmap.org/{z}/{x}/{y}.png'}
attribution=${TILE_ATTRIBUTION:-'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}
max_zoom=${TILE_MAX_ZOOM:-19}
language=${DEFAULT_LANGUAGE:-fr}
geocoder_url=${GEOCODER_URL-https://nominatim.openstreetmap.org/search}
geocoder_agent=${GEOCODER_USER_AGENT:-'oujda-transit (self-hosted; https://github.com/tiralmos/oujda-transit)'}
geocoder_email=${GEOCODER_EMAIL:-}
# Oujda and its surroundings: west,north,east,south.
geocoder_viewbox=${GEOCODER_VIEWBOX:-'-2.10,34.92,-1.75,34.55'}

case "$max_zoom" in
    ''|*[!0-9]*) fail "TILE_MAX_ZOOM must be a whole number, got '$max_zoom'" ;;
esac
case "$language" in
    fr|en|ar) ;;
    *) fail "DEFAULT_LANGUAGE must be fr, en or ar, got '$language'" ;;
esac

# ---- address search proxy ----
mkdir -p "$(dirname "$geocoder_conf")"
geocoder=false
case "$geocoder_url" in
    ''|off|false|none)
        : > "$geocoder_conf"
        echo "oujda-transit: address search disabled" ;;
    *)
        # These values end up inside nginx.conf, so only plain characters are allowed.
        printf '%s' "$geocoder_url" | grep -Eq '^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._~/%-]*)?$' \
            || fail "GEOCODER_URL must be a plain http(s) URL without a query string, got '$geocoder_url'"
        printf '%s' "$geocoder_agent" | grep -Eq '^[][A-Za-z0-9 .,:;/()+_@~=!?*&%-]+$' \
            || fail "GEOCODER_USER_AGENT contains characters that are not allowed: '$geocoder_agent'"
        [ -z "$geocoder_email" ] || printf '%s' "$geocoder_email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$' \
            || fail "GEOCODER_EMAIL is not an email address: '$geocoder_email'"
        printf '%s' "$geocoder_viewbox" | grep -Eq '^-?[0-9]+(\.[0-9]+)?(,-?[0-9]+(\.[0-9]+)?){3}$' \
            || fail "GEOCODER_VIEWBOX must be four numbers west,north,east,south, got '$geocoder_viewbox'"

        # nginx needs a DNS resolver to look the geocoder up at request time;
        # use the container's own (IPv6 addresses need brackets).
        resolvers=$(awk '/^nameserver/ { a = $2; if (a ~ /:/) a = "[" a "]"; printf "%s ", a }' /etc/resolv.conf)
        [ -n "$resolvers" ] || fail "no nameserver in /etc/resolv.conf for the address search"

        email_arg=""
        [ -z "$geocoder_email" ] || email_arg="&email=$geocoder_email"
        cat > "$geocoder_conf" <<EOF
# Generated at container start by 40-oujda-config.sh.
location = /api/geocode {
    if (\$arg_q = "") { return 400; }
    limit_req zone=geocode_rate burst=10;
    limit_req_status 429;

    resolver $resolvers valid=300s;
    resolver_timeout 5s;
    set \$geocoder "$geocoder_url";
    proxy_pass \$geocoder?format=jsonv2&limit=8&bounded=1&countrycodes=ma&viewbox=$geocoder_viewbox&accept-language=\$geocode_lang&q=\$arg_q$email_arg;
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_connect_timeout 5s;
    proxy_read_timeout 15s;

    # Identify this app, and don't pass on anything about the visitor.
    proxy_set_header User-Agent "$geocoder_agent";
    proxy_set_header Referer "";
    proxy_set_header Cookie "";
    proxy_set_header Authorization "";
    proxy_set_header X-Forwarded-For "";

    proxy_cache geocode_cache;
    proxy_cache_key "\$geocode_lang|\$arg_q";
    proxy_cache_valid 200 7d;
    proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
    proxy_hide_header Set-Cookie;
    proxy_hide_header Cache-Control;
    proxy_hide_header Access-Control-Allow-Origin;
}
EOF
        geocoder=true
        echo "oujda-transit: address search via $geocoder_url" ;;
esac

# ---- config.js ----
if [ ! -w "$target" ]; then
    echo "oujda-transit: $target is not writable, keeping the built-in defaults" >&2
    exit 0
fi

cat > "$target" <<EOF
// Generated at container start from environment variables.
window.OUJDA_CONFIG = {
  tileUrl: "$(js_string "$tile_url")",
  tileAttribution: "$(js_string "$attribution")",
  tileMaxZoom: $max_zoom,
  defaultLanguage: "$language",
  geocoder: $geocoder,
};
EOF
echo "oujda-transit: wrote config.js (tiles: $tile_url)"
