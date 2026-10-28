# Oujda Transit

A self-hostable web app for the Oujda bus network: every line and stop on an
OpenStreetMap map, with search, line pages, nearby stops, favorites and a trip
planner. Runs as a single small Docker container (nginx serving static files).

The network data (24 lines, 698 stops, 419 after corrections) was exported on 2026-10-22 from the
server behind the 7afilati app (SOMAYAR SA). It lives in [`data/`](data/) as CSV.

## Features

- **Map** of all stops on OpenStreetMap tiles, with a toggle to draw every line in its colour.
- **Search** stops and lines from one box: accent- and case-insensitive, tolerant of small typos
  and of the data's "Termunis/Terminis" spellings; lines by name or number (`L03`, `3`, `ligne 3`).
- **Address and place search** in the same box and in the trip planner: choose "Search addresses
  and places" under the suggestions to look up a street, school, pharmacy, café… in Oujda on
  OpenStreetMap (Nominatim). A place opens with its nearby stops and "start here / go here" buttons.
- **Line pages**: both directions, stops in order on a timeline with estimated minutes from the
  first stop, transfers to other lines at each stop, total length and duration, drawn on the map.
- **Stop pages**: every line and direction that serves the stop with the next stops, nearby stops
  within 400 m, coordinates and a link to OpenStreetMap.
- **Nearby**: stops within 800 m of your location (or of the map centre) with walking time.
- **Trip planner** between stops, addresses, your location or any point picked on the map. It finds the
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

The container has a health check (`/healthz`) and needs no volumes or database. Visitors' browsers
load the map tiles directly from the tile server. The container itself only goes out to the
internet for the address search (see below), and even that falls back to the browser when the
container can't get out; everything else works without outbound access.

### Address search

The browser asks the app's own server (`/api/geocode`), and nginx forwards the request to
[Nominatim](https://nominatim.org/), limited to the Oujda area. If the server can't reach
Nominatim (no outbound internet, DNS, a firewall, or Nominatim refusing the server's address),
the browser asks Nominatim directly instead, the same way it already loads map tiles; set
`GEOCODER_BROWSER_FALLBACK=off` to forbid that. When both fail, the message shows the error code.
This follows the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
for the public server:

- a search is sent only when someone chooses "Search addresses and places", never while typing;
- at most one request per second goes out for the whole site (extra ones wait, then get HTTP 429);
- results are cached by the server for 7 days and by the browser for the session;
- server requests carry an identifying User-Agent, and nothing about the visitor (no cookies, no referrer).

If searches fail, `docker logs oujda-transit` shows why the server couldn't reach the geocoder
(for example `could not be resolved`, `connect() failed` or an upstream `403`), and this checks it
from inside the container:

```sh
docker exec oujda-transit wget -S -qO- "http://127.0.0.1/api/geocode?q=pharmacie&lang=fr"
```

For heavy use, point `GEOCODER_URL` at your own Nominatim instance or a provider with a
Nominatim-compatible API. Set `GEOCODER_URL=off` to remove address search entirely.

### Behind Cloudflare or another cache

Every file URL carries a content version (`app.js?v=…`), set when the image is built, and the
service worker always revalidates with the server, so a new version shows up on the next page
load even if a proxy told browsers to keep files for hours. In Cloudflare, the
"Browser Cache TTL: Respect Existing Headers" setting avoids the extra delay entirely.

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
| `GEOCODER_URL` | `https://nominatim.openstreetmap.org/search` | Nominatim search endpoint for address search; `off` disables it |
| `GEOCODER_USER_AGENT` | `oujda-transit (self-hosted; …)` | User-Agent sent to the geocoder; put your site or contact in it |
| `GEOCODER_EMAIL` | (none) | Contact email passed to Nominatim, as its policy suggests for regular use |
| `GEOCODER_VIEWBOX` | `-2.10,34.92,-1.75,34.55` | Search area as west,north,east,south |
| `GEOCODER_BROWSER_FALLBACK` | `on` | `off` stops browsers from asking the geocoder directly when the server can't |

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
| `data/shapes.csv` | The path each line direction takes along the roads, point by point; the rows of a stop carry its id and how the leg from it is drawn (`road`, `map` or `straight`) |
| `data/corrections.csv` | Every change made to the export, one row each, with the reason and evidence |
| `data/source/` | The export exactly as it came from the operator's server, plus `figma_routes.geojson`, the routes ISA drew by hand on a Figma map about two years ago |
| `data/export-info.json` | When and where the CSVs were exported |

The CSVs in `data/` are generated: `tools/apply_corrections.py` applies `data/corrections.csv` to
`data/source/` and writes them. At build time, `tools/build_data.py` turns them into `network.json`
(what the app loads) and `network.geojson`.

### Line shapes

The export only lists each line's stops, so the app draws lines along the roads using
`data/shapes.csv`, made by `tools/build_shapes.py`. It routes each line direction through its stops
on OpenStreetMap roads (the public OSRM demo server, one request a second), once with and once
without letting the bus turn back at a stop, and keeps the shorter way for each leg between two
stops. Where that is still a long way round (often a one-way street or a stop snapped to the wrong
road), the leg follows ISA's hand-drawn map if the map is clearly shorter; a leg that stays absurd
is drawn straight. The stops always win over the map: shapes only join the stops in the data.
Re-run it after the stops change (a test fails when a shape no longer matches its stops):

```sh
python3 tools/build_shapes.py               # data/line_stops.csv -> data/shapes.csv (needs internet)
```

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

What the current corrections do (exported 2026-10-22, 698 stops before, 419 after):

- **Misplaced stops (41 moved, 2 split)**: stops kilometres away from their neighbours on the line
  were placed where the route says they must be, using, in order of preference, a matching
  OpenStreetMap feature on the route (for example L02's *Maroc Telecom*, the agency on Boulevard
  Abderrahim Bouabid, while L20 keeps its own *Maroc Telecom* in the north), the named street on the
  road route between the stop's neighbours (*Route Aounia 2* on Route El Aounia), the same place on
  another line (*Hay Lmharach 1* = L15's *Mharach I*), or a point part-way along the road route
  between the neighbours (`low` confidence). Road routes come from the OSRM demo server and
  OpenStreetMap features from Nominatim.
- **Line ends placed from ISA's hand-drawn Figma map** (8 moved, 1 split): the termini and last
  stops that had no other evidence (city-centre coordinates for L07's *Terminus Faculté des Lettres*,
  L13's *Terminus Bouchtat*, L17's *Terminus Village Bekay*, L02's far terminus, ...) were put where
  the Figma "Oujda Bus Map" ends each line. The map was lined up with real coordinates by matching
  its stop dots to the stops of the same lines (scale, offset, north up; median error about 23 m).
  The `flag` action is still available for stops that need a check; none are flagged today.
- **Merged stops (169)**: stops less than about 20 m apart became one stop, and so did stops with
  the same name up to 60 m apart. Not merged: a line's aller and retour termini (each direction keeps
  its own stop), two stops of the same line and direction, and stops whose new position is only an
  estimate.
- **Merges from ISA's review (112 merged, 51 renamed, 2026-10-27)**: every pair of stops under
  150 m apart was scored (distance, name, street from OpenStreetMap, shared lines, aller/retour
  pairs) in a spreadsheet, and ISA decided each pair. The pairs ISA marked "Merge" became 94
  places; where pairs chain (A+B and B+C) all their stops became one. This includes termini whose
  aller and retour stops the first pass kept apart (*Terminus Maghreb Arabi*, *Terminus Samara*,
  *Terminus Marjane*, ...). Each place has the name ISA chose; the other names stay searchable.
- **Names (471 renamed)**: every name is in title case (the first letter of every word capitalised,
  except French small words such as *de*, *des*, *la*: *Faculté des Sciences*, *Consulat d'Algérie*;
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
                     # (no address search there: it needs the container's /api/geocode)
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
docker/            nginx config and the start-up script that writes config.js and the geocoder proxy
tests/             unit tests and the end-to-end smoke test
```

## Licence

Code: MIT (see `LICENSE`). Leaflet: BSD-2-Clause (`web/vendor/leaflet/LICENSE`). Map data and
tiles © OpenStreetMap contributors. The bus network data comes from SOMAYAR SA's 7afilati service
and is not covered by this repository's licence.
