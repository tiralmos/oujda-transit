# Oujda Transit

A self-hostable web app for the Oujda bus network: every line and stop on an
OpenStreetMap map, with search, line pages, nearby stops, favorites and a trip
planner. Runs as a single small Docker container (nginx serving static files).

The network data (24 lines, 698 stops, 529 after corrections) was exported on 2026-10-22 from the
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

Then open <http://localhost:3002>. To use another port: `PORT=9000 docker compose up -d --build`.

Without Compose:

```sh
docker build -t oujda-transit .
docker run -d --name oujda-transit -p 3002:80 --restart unless-stopped oujda-transit
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
| `data/stops.csv` | One row per stop: id, name, label, coordinates, lines serving it, plus other names, merged stop ids, the corrections applied and any review note |
| `data/line_stops.csv` | Each line's stops in order, per direction (`aller` / `retour`) |
| `data/corrections.csv` | Every change made to the export, one row each, with the reason and evidence |
| `data/source/` | The export exactly as it came from the operator's server |
| `data/export-info.json` | When and where the CSVs were exported |

The CSVs in `data/` are generated: `tools/apply_corrections.py` applies `data/corrections.csv` to
`data/source/` and writes them. At build time, `tools/build_data.py` turns them into `network.json`
(what the app loads) and `network.geojson`.

### Corrections

The export has misplaced stops, the same stop entered several times and inconsistent names. Every
fix is a row in `data/corrections.csv`, so it can be reviewed, edited or undone:

| action | what it does | columns used |
|---|---|---|
| `move` | puts a stop at new coordinates | `station_id`, `new_lat`, `new_lng` |
| `rename` | gives a stop a new name (the old one stays searchable) | `station_id`, `new_name` |
| `merge` | replaces a stop by another one everywhere; its name stays searchable and its id redirects in the app | `station_id`, `target_id` |
| `split` | gives some lines their own copy of a stop, e.g. when two lines share a stop id but only one is in the right place | `station_id`, `lines` (`L02` or `L02:aller`), `target_id` (new id), `new_name`, `new_lat`, `new_lng` |
| `flag` | changes nothing but marks the stop for review in the app, with `reason` as the note | `station_id`, `reason` |

`old_name`, `old_lat` and `old_lng` record what the row expects to find; if they no longer match
(for example after a new export), the row is still applied and a warning names it. `confidence`
(`high`, `medium`, `low`) and `evidence` say how each new position was found. Rows are applied in
order and ids only need to be unique, so to change a decision edit or delete its row, and to add
one append a row. Then regenerate the CSVs:

```sh
python3 tools/apply_corrections.py          # data/source + data/corrections.csv -> data/*.csv
npm test                                    # includes a check that data/*.csv is up to date
```

What the current corrections do (exported 2026-10-22, 698 stops before, 529 after):

- **Misplaced stops (33 moved, 1 split)**: stops kilometres away from their neighbours on the line
  were placed where the route says they must be, using, in order of preference, a matching
  OpenStreetMap feature on the route (for example L02's *Maroc Telecom*, the agency on Boulevard
  Abderrahim Bouabid, while L20 keeps its own *Maroc Telecom* in the north), the named street on the
  road route between the stop's neighbours (*Route Aounia 2* on Route El Aounia), the same place on
  another line (*Hay Lmharach 1* = L15's *Mharach I*), or a point part-way along the road route
  between the neighbours (`low` confidence). Road routes come from the OSRM demo server and
  OpenStreetMap features from Nominatim.
- **Stops left for review (7 flagged)**: line ends with no evidence to place them (for example L17's
  *Terminus Village Bekay* and L07's *Terminus Faculte des Lettres*, both with city-centre
  coordinates). They keep their coordinates and show an orange "!" in the app.
- **Merged stops (170)**: stops less than about 20 m apart became one stop, and so did stops with
  the same name up to 60 m apart. Not merged: a line's aller and retour termini (each direction keeps
  its own stop), two stops of the same line and direction, and stops whose new position is only an
  estimate.
- **Names (474 renamed)**: every name is in title case (the first letter of every word capitalised;
  Roman numerals and acronyms such as OFPPT stay upper case), with French words spell-checked (*cafe* → *café*, *ecole* → *école*, *carfour* →
  *carrefour*, ...). A merged stop that combined two differently named stops is called
  "A / B", the one serving more lines first (*Pharmacie Hassan II / Clinique Ibn Sina*); when it
  combined three or more names it takes the most prominent one and the others stay searchable.
  Stops of the same terminus share one name (*Terminus Maghreb Arabi*,
  *Terminus Enakhil* for Sahat Nakheel, ...); "Termunis/Terminis", "Mousquee" and "/R" or "retour"
  suffixes are fixed; stops with the same name in different places get their neighbourhood added
  (*OFPPT (Hay Hakkou)*); stop 608, named `2026-07-09 00:00:00` in the export, is "9 juillet" read
  as a date and was merged into *Place 9 Juillet*.

The app then makes these display fixes, each listed on its About page: generated line colours
instead of the export's near-black placeholders (`#000000`, `#000001`, ...), names that are still in
ALL CAPS or all lower case put in title case, and an orange "!" on any stop still far off its
line's path.

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
BASE_URL=http://localhost:3002 node tests/e2e/smoke.mjs
```

Layout:

```
data/              corrected CSVs, corrections.csv, and the raw export in source/
tools/             apply_corrections.py (export + corrections -> CSVs), build_data.py (CSV -> JSON/GeoJSON)
web/               the static app (index.html, css/, js/, vendor/leaflet/, sw.js)
docker/            nginx config and the start-up script that writes config.js
tests/             unit tests and the end-to-end smoke test
```

## Licence

Code: MIT (see `LICENSE`). Leaflet: BSD-2-Clause (`web/vendor/leaflet/LICENSE`). Map data and
tiles © OpenStreetMap contributors. The bus network data comes from SOMAYAR SA's 7afilati service
and is not covered by this repository's licence.
