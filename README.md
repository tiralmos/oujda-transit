# Oujda Transit

A web app for the Oujda (Morocco) bus network on OpenStreetMap: search stops and places, view lines on the map, and plan trips.

## Features

- **Search** for stops, lines (`8`, `L08`) and real places that are not stops, such as *Lycée Zineb Ennafzaouia*. Stop search is accent- and typo-tolerant (`termunis` finds *Terminus …*).
- **Place search through OpenStreetMap.** The server queries Nominatim, then Photon. When the server cannot reach them (no outbound internet, rate limit, outage), the browser queries OpenStreetMap directly, so place search keeps working.
- **Lines**: each line has its own colour. The line page shows both directions, the ordered stop list, and connections at each stop. You can also show every line on the map at once.
- **Stops**: the lines serving a stop in each direction, the next stops, and nearby stops for changing lines.
- **Trip planner** from any point to any point (a stop, a place, your location, or a point you tap on the map). It suggests up to three options, with walking, changes and estimated times. The data has no timetables, so times are estimates.
- **Nearby stops** from your location, with walking distance.
- **Favourites** (stops, lines, trips) and recent searches, saved in the browser.
- **Shareable links** for every stop, line, place and trip.
- **French, English and Arabic** (right-to-left), plus a dark theme.
- **Installable and offline-friendly (PWA)**: the app, stops and lines work offline, and map tiles you have viewed are cached.

## Run with Docker (port 3002)

```sh
docker compose up -d --build
# or
docker build -t oujda-transit .
docker run -d --name oujda-transit -p 3002:3002 --restart unless-stopped oujda-transit
```

Open http://localhost:3002.

"Locate me" and offline mode need a secure context. They work on `localhost`. On a server, put the app behind HTTPS (for example with a reverse proxy such as Caddy, Traefik or nginx).

### Line endings

The startup script `docker-entrypoint.sh` must keep Unix (LF) line endings. Three things make sure it does:

1. `.gitattributes` forces LF for `*.sh` and the `Dockerfile`, even on Windows checkouts.
2. The `Dockerfile` strips any `\r` from the script during the build.
3. CI and the test suite fail if the script contains a carriage return.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | HTTP port |
| `DATA_DIR` | `/app/data` | Folder with `stops.csv`, `lines.csv`, `line_stops.csv` |
| `DISABLE_SERVER_GEOCODING` | `false` | `true` makes the browser query OpenStreetMap directly |
| `GEOCODER_USER_AGENT` | `oujda-transit/1.0 (+repo url)` | Contact string required by the Nominatim usage policy |
| `NOMINATIM_URL` / `PHOTON_URL` | public OSM instances | Geocoders used by the server |
| `PUBLIC_NOMINATIM_URL` / `PUBLIC_PHOTON_URL` | public OSM instances | Geocoders used by the browser fallback |
| `TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Map tiles |

### Updating the data

Replace the CSV files in `data/` and rebuild, or mount a folder instead:

```sh
docker run -d -p 3002:3002 -v "$PWD/data:/app/data:ro" oujda-transit
```

The colours in `lines.csv` are placeholders (`#000000`, `#000001`, …), so the app assigns 24 distinct colours. If you put real, unique colours in `line_color`, the app uses those instead. Stop labels that a spreadsheet turned into dates (for example `2026-07-09 00:00:00`) are shown as street names again (`9 Juillet`).

## Development

Node 20 or newer. There are no npm dependencies, and Leaflet is bundled in `public/vendor`.

```sh
npm start   # http://localhost:3002
npm test
```

## API

| Endpoint | Description |
|---|---|
| `GET /api/network` | All stops and lines (used by the app; cached offline) |
| `GET /api/search?q=` | Stops and lines matching the text |
| `GET /api/places?q=` | Places from OpenStreetMap, or `503` with fallback URLs |
| `GET /api/stops/:id` | Stop with services and nearby stops |
| `GET /api/lines` · `GET /api/lines/:id` | Lines, or one line with ordered stops (`:id` can be `L08`) |
| `GET /api/nearby?lat=&lng=` | Stops near a point |
| `GET /api/plan?from=lat,lng&to=lat,lng` | Trip itineraries |
| `GET /healthz` | Health check |

Map data © OpenStreetMap contributors. Place search uses Nominatim and Photon. Follow their usage policies, or point the `*_URL` variables to your own instances for heavy use.
