#!/bin/sh
# Writes config.js from environment variables when the container starts.
set -eu

target=/usr/share/nginx/html/config.js

# Escape a value for use inside a double-quoted JavaScript string.
js_string() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's#</#<\\/#g' | tr -d '\r\n'
}

tile_url=${TILE_URL:-'https://tile.openstreetmap.org/{z}/{x}/{y}.png'}
attribution=${TILE_ATTRIBUTION:-'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}
max_zoom=${TILE_MAX_ZOOM:-19}
language=${DEFAULT_LANGUAGE:-fr}

case "$max_zoom" in
    ''|*[!0-9]*) echo "oujda-transit: TILE_MAX_ZOOM must be a whole number, got '$max_zoom'" >&2; exit 1 ;;
esac
case "$language" in
    fr|en|ar) ;;
    *) echo "oujda-transit: DEFAULT_LANGUAGE must be fr, en or ar, got '$language'" >&2; exit 1 ;;
esac

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
};
EOF
echo "oujda-transit: wrote config.js (tiles: $tile_url)"
