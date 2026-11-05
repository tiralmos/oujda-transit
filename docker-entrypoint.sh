#!/bin/sh
# Startup script for the Oujda Transit container.
set -eu

: "${PORT:=3002}"
: "${DATA_DIR:=/app/data}"
export PORT DATA_DIR

for f in stops.csv lines.csv line_stops.csv; do
  if [ ! -f "$DATA_DIR/$f" ]; then
    echo "Missing $DATA_DIR/$f. Mount your data folder or rebuild the image." >&2
    exit 1
  fi
done

# `docker run ... oujda-transit export-gtfs [folder]` writes the GTFS feed instead of serving the app.
if [ "${1:-}" = "export-gtfs" ]; then
  shift
  exec node /app/src/export-gtfs.js "${1:-/out}"
fi

echo "Starting Oujda Transit on port $PORT (data: $DATA_DIR)"
exec node /app/src/server.js "$@"
