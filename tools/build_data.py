"""Turn the Oujda CSV exports into the JSON files the web app loads.

Usage:  python3 tools/build_data.py <csv_dir> <out_dir>

Reads lines.csv, stops.csv, line_stops.csv and export-info.json (when the CSVs
were exported, and from where) from <csv_dir> and writes
network.json and network.geojson to <out_dir>. Standard library only.

The CSVs are the corrected ones written by tools/apply_corrections.py; they
are passed through unchanged except for display clean-ups, each of which is
recorded in the "issues" list so the app can show it:
  * stop names that are not names (e.g. a timestamp) are shown as "Stop #id";
  * the same stop listed several times in a row on a line is listed once;
  * placeholder line colours (#000000, #000001, ...) are replaced by
    generated, distinguishable colours;
  * stops whose coordinates look wrong for a line, or that carry a review
    note from the corrections, are flagged (not moved).
"""
import colorsys
import csv
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

# Ride-time estimates: buses average BUS_KMH in town; on long gaps between
# stops (out-of-town stretches) everything past the first km runs at FAST_KMH.
# DETOUR accounts for streets being longer than the straight line.
BUS_KMH = 18.0
FAST_KMH = 35.0
DETOUR = 1.25
MIN_SEGMENT_MIN = 0.5

# A stop is flagged as misplaced on a line when going through it is far
# longer than going straight from the previous stop to the next one.
SPIKE_RATIO = 3.0
SPIKE_SLACK_KM = 2.0

TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$")
TERMINUS_TYPO_RE = re.compile(r"\b(termunis|terminis|termenus)\b", re.IGNORECASE)
LOWER_WORDS = {"de", "des", "du", "la", "le", "les", "et", "au", "aux", "en", "ou", "d", "l"}
# Roman numerals stay upper case: "Hassan II", not "Hassan Ii".
ROMAN_RE = re.compile(r"^(i{1,3}|iv|vi{0,3}|ix|x)$", re.IGNORECASE)
DIRECTIONS = (("aller", "1"), ("retour", "0"))


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def haversine_km(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def segment_minutes(km):
    town = min(km, 1.0)
    fast = km - town
    return max(MIN_SEGMENT_MIN, (town / BUS_KMH + fast / FAST_KMH) * DETOUR * 60)


def is_missing_name(label):
    return not label.strip() or bool(TIMESTAMP_RE.match(label.strip()))


def display_label(label):
    """Readable stop name: ALL CAPS / all lower case names in title case (French small words
    lower case), 'Termunis' typos fixed.

    The corrected CSVs are already in title case; single words such as "CHU" are kept as they are.
    """
    text = re.sub(r"\s+", " ", label).strip()
    letters = [c for c in text if c.isalpha()]
    if " " in text and letters and (all(c.isupper() for c in letters) or all(c.islower() for c in letters)):
        text = " ".join(w.upper() if ROMAN_RE.match(w) and (i > 0 or len(w) > 1)
                        else w if i > 0 and w in LOWER_WORDS else w[:1].upper() + w[1:]
                        for i, w in enumerate(text.lower().split(" ")))
    if text:
        text = text[0].upper() + text[1:]
    return TERMINUS_TYPO_RE.sub(lambda m: "Terminus" if m.group(0)[0].isupper() else "terminus", text)


def slug_label(slug):
    return display_label(slug.replace("-", " "))


def line_number(name):
    m = re.search(r"\d+", name)
    return (int(m.group(0)) if m else 10**6, name)


def is_placeholder_color(color):
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", color.strip())
    if not m:
        return True
    v = m.group(1)
    return max(int(v[i:i + 2], 16) for i in (0, 2, 4)) < 0x30


def generated_color(index):
    hue = (index * 137.508) % 360 / 360
    light = 0.40 if index % 2 == 0 else 0.33
    r, g, b = colorsys.hls_to_rgb(hue, light, 0.75)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def text_color(bg):
    r, g, b = (int(bg[i:i + 2], 16) / 255 for i in (1, 3, 5))
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
    lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    # Pick whichever of black/white has the better contrast ratio.
    return "#ffffff" if (1.05 / (lum + 0.05)) >= ((lum + 0.05) / 0.05) else "#000000"


def build(csv_dir):
    lines_csv = read_csv(os.path.join(csv_dir, "lines.csv"))
    stops_csv = read_csv(os.path.join(csv_dir, "stops.csv"))
    line_stops_csv = read_csv(os.path.join(csv_dir, "line_stops.csv"))
    issues = []

    stops = {}
    merged_stops = {}
    for r in stops_csv:
        sid = int(r["station_id"])
        for old in (r.get("merged_ids") or "").split():
            merged_stops[old] = sid
        raw = r["station_label"] or r["station_name"]
        missing = is_missing_name(raw)
        alt_names = [n.strip() for n in (r.get("alt_names") or "").split("|") if n.strip()]
        review = (r.get("review_note") or "").strip()
        stops[sid] = {
            "id": sid,
            "slug": r["station_name"],
            "name": f"Stop #{sid}" if missing else display_label(raw),
            "sourceName": raw,
            "altNames": alt_names,
            "lat": float(r["lat"]),
            "lng": float(r["lng"]),
            "lines": [],
            "flags": ["missing_name"] if missing else [],
        }
        if missing:
            issues.append({"type": "missing_name", "stop": sid,
                           "detail": f"The source gives this stop the name \"{raw}\"."})
        if review:
            stops[sid]["flags"].append("suspect_location")
            issues.append({"type": "suspect_location", "stop": sid, "detail": review})

    seqs = {}
    for r in line_stops_csv:
        key = (int(r["line_id"]), r["sens"])
        seqs.setdefault(key, []).append(r)
    for rows in seqs.values():
        rows.sort(key=lambda r: int(r["stop_sequence"]))

    repeated = set()
    placeholder = all(is_placeholder_color(l["line_color"]) for l in lines_csv)
    lines = []
    for index, l in enumerate(sorted(lines_csv, key=lambda l: line_number(l["line_name"]))):
        lid = int(l["line_id"])
        color = generated_color(index) if placeholder else "#" + l["line_color"].strip().lstrip("#").lower()
        line = {
            "id": lid,
            "name": l["line_name"],
            "color": color,
            "textColor": text_color(color),
            "sourceColor": l["line_color"],
            "directions": {},
        }
        for direction, sens in DIRECTIONS:
            rows = seqs.get((lid, sens), [])
            ids = []
            for r in rows:
                sid = int(r["station_id"])
                if sid not in stops:
                    raise ValueError(f"line_stops.csv refers to unknown stop {sid}")
                if ids and ids[-1] == sid:
                    if (lid, direction, sid) in repeated:
                        continue
                    repeated.add((lid, direction, sid))
                    issues.append({"type": "repeated_stop", "stop": sid, "line": lid, "direction": direction,
                                   "detail": f"Listed several times in a row on {l['line_name']} ({direction}); shown once."})
                    continue
                ids.append(sid)
            if not ids:
                continue
            pts = [(stops[s]["lat"], stops[s]["lng"]) for s in ids]
            seg_km = [haversine_km(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
            suspect = [False] * len(ids)
            for i in range(1, len(ids) - 1):
                bypass = haversine_km(pts[i - 1], pts[i + 1])
                if seg_km[i - 1] + seg_km[i] > SPIKE_RATIO * bypass + SPIKE_SLACK_KM:
                    suspect[i] = True
                    seg_km[i - 1] = seg_km[i] = bypass / 2
            for i, s in enumerate(ids):
                if suspect[i]:
                    if "suspect_location" not in stops[s]["flags"]:
                        stops[s]["flags"].append("suspect_location")
                    issues.append({"type": "suspect_location", "stop": s, "line": lid, "direction": direction,
                                   "detail": f"On {l['line_name']} ({direction}) this stop sits far off the path between "
                                             f"{stops[ids[i - 1]]['name']} and {stops[ids[i + 1]]['name']}; "
                                             f"its coordinates are probably wrong."})
            line["directions"][direction] = {
                "headsign": l[f"{direction}_to"],
                "stops": ids,
                "minutes": [round(segment_minutes(k), 2) for k in seg_km],
            }
            for s in ids:
                if lid not in stops[s]["lines"]:
                    stops[s]["lines"].append(lid)
        lines.append(line)

    if placeholder:
        issues.append({"type": "placeholder_colors",
                       "detail": "The source gives every line a near-black placeholder colour "
                                 "(#000000, #000001, ...); the app uses generated colours instead."})

    order = {l["id"]: i for i, l in enumerate(lines)}
    for s in stops.values():
        s["lines"].sort(key=order.get)
        if not s["lines"]:
            issues.append({"type": "unserved_stop", "stop": s["id"], "detail": "No line serves this stop."})

    info_path = os.path.join(csv_dir, "export-info.json")
    info = {}
    if os.path.exists(info_path):
        with open(info_path, encoding="utf-8") as f:
            info = json.load(f)

    lats = [s["lat"] for s in stops.values()]
    lngs = [s["lng"] for s in stops.values()]
    return {
        "city": "Oujda",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "exported": info.get("exported"),
        "source": info.get("source"),
        "assumptions": {"busKmh": BUS_KMH, "fastKmh": FAST_KMH, "detour": DETOUR},
        "bounds": [[min(lats), min(lngs)], [max(lats), max(lngs)]],
        "lines": lines,
        "stops": sorted(stops.values(), key=lambda s: s["id"]),
        "mergedStops": merged_stops,
        "issues": issues,
    }


def geojson(network):
    stops = {s["id"]: s for s in network["stops"]}
    features = []
    for l in network["lines"]:
        for direction, d in l["directions"].items():
            features.append({
                "type": "Feature",
                "properties": {"line": l["name"], "direction": direction, "color": l["color"],
                               "from": stops[d["stops"][0]]["name"], "to": stops[d["stops"][-1]]["name"]},
                "geometry": {"type": "LineString",
                             "coordinates": [[stops[s]["lng"], stops[s]["lat"]] for s in d["stops"]]},
            })
    names = {l["id"]: l["name"] for l in network["lines"]}
    for s in network["stops"]:
        features.append({
            "type": "Feature",
            "properties": {"id": s["id"], "name": s["name"], "lines": [names[i] for i in s["lines"]],
                           "flags": s["flags"]},
            "geometry": {"type": "Point", "coordinates": [s["lng"], s["lat"]]},
        })
    return {"type": "FeatureCollection", "features": features}


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    csv_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    network = build(csv_dir)
    with open(os.path.join(out_dir, "network.json"), "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out_dir, "network.geojson"), "w", encoding="utf-8") as f:
        json.dump(geojson(network), f, ensure_ascii=False, separators=(",", ":"))
    kinds = {}
    for i in network["issues"]:
        kinds[i["type"]] = kinds.get(i["type"], 0) + 1
    print(f"{len(network['lines'])} lines, {len(network['stops'])} stops, issues: {kinds}")


if __name__ == "__main__":
    main()
