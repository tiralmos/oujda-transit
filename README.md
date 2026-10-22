# Oujda Transit

A self-hostable web app for the Oujda bus network: every line and stop on an
OpenStreetMap map, with search, line pages, nearby stops, favorites and a trip
planner. Runs as a single small Docker container (nginx serving static files).

The network data (24 lines, 698 stops) was exported on 2026-10-22 from the
server behind the 7afilati app (SOMAYAR SA). It lives in [`data/`](data/) as CSV.

## Features

- **Map** of all stops on OpenStreetMap tiles, with a toggle to draw every line in its colour.
- **Search** stops and lines from one box: accent- and case-insensitive, tolerant of small typos
  and of the data's "Termunis/Terminis" spellings; lines by name or number (`L03`, `3`, `ligne 3`).
- **Line pages**: both directions, stops in order on a timeline with estimated minutes from the
  first stop, transfers to other lines at each stop, total length and duration, drawn on the map.
- **Stop pages**: every line and direction that serves the stop with the next stops, nearby stops
  within 400 m, coordinates and a link to OpenStreetMap.
- **Nearby**: stops within 800 m of your location (or of the map centre) with walking time.
- **Trip planner** between stops, your location or any point picked on the map. It finds the
  fastest option, a fewest-transfers option and a walk-only option for short trips, using walks of
  up to 400 m between stops for transfers and up to 1 km at each end.
- **Favorites** (lines and stops) and **recent stops**, saved in the browser.
- **Shareable links** for every view, including planned trips.
- **French, English and Arabic** (right-to-left) interface; light, dark and automatic themes.
- **Works on phones** (bottom-sheet layout), installable as a PWA, opens offline once visited.
- **Data downloads**: the CSVs, a GeoJSON of all lines and stops, and the app's JSON.
- **Data-quality notes** in the app's About page (see below).

### What it does not do: live buses

SOMAYAR's server has live bus GPS positions and predicted arrivals, but this app never contacts
it. Showing live data would mean continuous requests to a third-party server without permission,
so everything here is static. The data has no timetables either, so every time shown is an
estimate (buses at 18 km/h in town and 35 km/h on long gaps between stops, a 5-minute wait each
time you board, walking at 4.8 km/h).

## Run it

```sh
git clone https://github.com/tiralmos/oujda-transit.git
cd oujda-transit
docker compose up -d --build
```

Then open <http://localhost:8080>. To use another port: `PORT=9000 docker compose up -d --build`.

Without Compose:

```sh
docker build -t oujda-transit .
docker run -d --name oujda-transit -p 8080:80 --restart unless-stopped oujda-transit
```

The container has a health check (`/healthz`) and needs no volumes, database or outbound access;
visitors' browsers load the map tiles directly from the tile server.

### HTTPS and location

Browsers only allow "My location" (Nearby, planner) on `https://` sites or `localhost`. When you
host it for others, put it behind a reverse proxy with TLS (Caddy, Traefik, nginx…). Everything
else works over plain HTTP.

### Settings

Set these environment variables on the container (see `docker-compose.yml`):

| Variable | Default | Purpose |
|---|---|---|
| `TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Map tile URL template |
| `TILE_ATTRIBUTION` | © OpenStreetMap contributors | Attribution shown on the map (HTML allowed) |
| `TILE_MAX_ZOOM` | `19` | Highest zoom level of the tile server |
| `DEFAULT_LANGUAGE` | `fr` | `fr`, `en` or `ar`; used when the browser's language isn't one of these |

The public OpenStreetMap tile server is fine for personal and light use, but its
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/) asks heavier users to
run their own tile server or use a tile provider. Point `TILE_URL` at one if you expect real
traffic, and keep the attribution.

## Data

| File | Contents |
|---|---|
| `data/lines.csv` | One row per line: id, name, colour, termini and stop count per direction |
| `data/stops.csv` | One row per stop: id, name, label, coordinates, lines serving it |
| `data/line_stops.csv` | Each line's stops in order, per direction (`aller` / `retour`) |
| `data/export-info.json` | When and where the CSVs were exported |

At build time, `tools/build_data.py` turns these into `network.json` (what the app loads) and
`network.geojson`. To update the data, replace the CSVs (same columns), update
`export-info.json`, and rebuild the image.

### Known problems in the source data

The app shows the data as exported, with these display fixes, each also listed on the About page:

- **Stop 608** (L25, retour) is named `2026-07-09 00:00:00` in the source; it's shown as "Stop #608".
- **Line colours** are placeholders in the source (`#000000`, `#000001`, … all near-black), so the
  app generates distinct colours.
- **Repeated stops**: L01 retour lists Clinique Ibn Sina twice in a row, and L17 aller and L18 aller
  list one stop three times in a row. Each is shown once.
- **Doubtful coordinates**: 13 stops sit kilometres off their line's path between their neighbours
  (for example stop 8, Aboubeker Kadiri 1, is 18 km from both neighbours on L08). They're marked
  with an orange "!" and excluded from walking transfers, and ride times around them are estimated
  from the neighbouring stops. Their coordinates are not changed.
- Stop names keep the source's spelling; ALL-CAPS and all-lowercase names are put in title case and
  "Termunis/Terminis" is shown as "Terminus". The original name is shown in each stop's details.

## Development

No build step for the front end: plain ES modules, with Leaflet 1.9.4 vendored in `web/vendor/`.

```sh
npm run serve        # builds web/data/ from the CSVs and serves web/ on http://localhost:8000
npm test             # Python tests for the data build, Node tests for search, planner and strings
```

End-to-end test against a running container (needs Playwright with Chromium):

```sh
docker compose up -d --build
npm install --no-save playwright && npx playwright install chromium
BASE_URL=http://localhost:8080 node tests/e2e/smoke.mjs
```

Layout:

```
data/              source CSVs
tools/             build_data.py (CSV -> JSON/GeoJSON)
web/               the static app (index.html, css/, js/, vendor/leaflet/, sw.js)
docker/            nginx config and the start-up script that writes config.js
tests/             unit tests and the end-to-end smoke test
```

## Licence

Code: MIT (see `LICENSE`). Leaflet: BSD-2-Clause (`web/vendor/leaflet/LICENSE`). Map data and
tiles © OpenStreetMap contributors. The bus network data comes from SOMAYAR SA's 7afilati service
and is not covered by this repository's licence.
