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
| `DATA_DIR` | `/app/data` | Folder with `stops.csv`, `lines.csv`, `line_stops.csv`, and optionally `shapes.geojson` (the road path of each line direction; without it lines are drawn stop to stop) and `gtfs.json` (GTFS export settings) |
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

## GTFS export

The app's data can be exported as a [GTFS](https://gtfs.org/schedule/reference/) feed, the format used by Google Maps, transit map tools and trip planners. The feed is built from the same files as the app (`stops.csv`, `lines.csv`, `line_stops.csv`, `shapes.geojson`), so after any data change you just export it again.

```sh
npm run gtfs                # writes gtfs/oujda-gtfs.zip (and the .txt files in gtfs/oujda-gtfs/)
npm run gtfs:validate       # same, then checks it with MobilityData's validator (needs Java 17+ and Maven)

# with Docker, from the image (add -v "$PWD/data:/app/data:ro" to use your local data)
docker run --rm --user "$(id -u)" -v "$PWD/gtfs:/out" oujda-transit export-gtfs
```

The running app also serves the current feed at `GET /api/gtfs.zip` (linked at the bottom of the side panel), so `http://<your server>:3002/api/gtfs.zip` is a stable URL that always matches the data.

What is in it: `agency`, `stops` (every served stop), `routes` (one per line, with the app's colours), `trips` (one per line direction, `direction_id` 0 = aller, 1 = retour), `stop_times`, `frequencies`, `shapes` (the road path of each direction), `calendar` and `feed_info`. `fare_attributes` and `fare_rules` are added when a fare is set.

**Assumptions, because the data has no timetables.** Edit them in `data/gtfs.json`:

| Setting | Default | Meaning |
|---|---|---|
| `periods` | 06:00–09:00 every 15 min, 09:00–16:00 every 20, 16:00–19:00 every 15, 19:00–21:00 every 30 | Buses leave each terminus at this headway (`frequencies.txt`, not exact departure times) |
| `lines` | none | Per-line headways, e.g. `"L13": { "periods": [...] }` |
| `speed_kmh`, `dwell_seconds` | 18 km/h, 20 s | Stop times are road distance ÷ speed plus a stop at each stop (same as the trip planner) |
| `service_days`, `start_date`, `valid_days` | every day, from the export date, for 365 days | `calendar.txt` |
| `agency` | "Bus urbain Oujda", repo URL, `Africa/Casablanca`, French | Replace with the operator's real name and website |
| `fare` | none | Set `price` (in MAD) to add a single flat fare |

Stops that are still off the drawn road (to be placed by hand) are exported with estimated times but without a distance along the shape; the export lists them, and the validator reports them as warnings.

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
| `GET /api/gtfs.zip` | The network as a GTFS feed |
| `GET /healthz` | Health check |

Map data © OpenStreetMap contributors. Place search uses Nominatim and Photon. Follow their usage policies, or point the `*_URL` variables to your own instances for heavy use.
