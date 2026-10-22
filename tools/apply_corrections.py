"""Apply the hand-reviewed stop corrections to the raw Oujda export.

Usage:  python3 tools/apply_corrections.py [source_dir] [corrections_csv] [out_dir]
        (defaults: data/source  data/corrections.csv  data)

Reads the untouched export (lines.csv, stops.csv, line_stops.csv) from
source_dir, applies every row of corrections_csv in file order and writes the
corrected lines.csv, stops.csv and line_stops.csv to out_dir. Standard library
only.

Each correction row has an `action`:
  move    put station_id at new_lat,new_lng
  rename  give station_id the label new_name (its slug is regenerated)
  merge   replace station_id by target_id everywhere and drop station_id;
          its label is kept in the target's alt_names
  split   give the lines listed in `lines` (e.g. "L02" or "L02:aller") their
          own copy of station_id, numbered target_id, optionally renamed
          (new_name) and placed (new_lat,new_lng)
  flag    change nothing, but attach `reason` as a review note to the stop

old_name / old_lat / old_lng record what the row expects to find. When they no
longer match (for example after a fresh export), the row is still applied and
a warning is printed, so stale rows are easy to spot. Rows can be deleted,
edited or added by hand; ids only have to be unique.
"""
import csv
import math
import os
import re
import sys
import unicodedata

ACTIONS = ("move", "rename", "merge", "split", "flag")
STOP_FIELDS = ["station_id", "station_name", "station_label", "lat", "lng", "lines", "line_count",
               "alt_names", "merged_ids", "corrections", "review_note"]
COORD_TOLERANCE_M = 2.0


class CorrectionError(Exception):
    pass


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


def write_csv(path, fields, rows):
    # utf-8-sig so Excel opens the accents correctly, like the original export.
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def distance_m(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def slugify(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "stop"


def line_number(name):
    m = re.search(r"\d+", name)
    return (int(m.group(0)) if m else 10**6, name)


def parse_lines(spec):
    """'L02' or 'L02:aller, L20' -> {(line_name, direction or None)}."""
    out = set()
    for part in filter(None, (p.strip() for p in (spec or "").split(","))):
        name, _, direction = part.partition(":")
        out.add((name.strip(), direction.strip() or None))
    return out


class Network:
    def __init__(self, source_dir):
        self.line_fields, self.lines = read_csv(os.path.join(source_dir, "lines.csv"))
        _, stops = read_csv(os.path.join(source_dir, "stops.csv"))
        self.ls_fields, self.line_stops = read_csv(os.path.join(source_dir, "line_stops.csv"))
        self.stops = {}
        for r in stops:
            sid = int(r["station_id"])
            self.stops[sid] = {
                "station_id": sid, "station_name": r["station_name"], "station_label": r["station_label"],
                "lat": float(r["lat"]), "lng": float(r["lng"]), "source_coords": (r["lat"], r["lng"]),
                "alt_names": [], "merged_ids": [], "corrections": [], "review_note": [],
            }
        for r in self.line_stops:
            if int(r["station_id"]) not in self.stops:
                raise CorrectionError(f"line_stops.csv refers to unknown stop {r['station_id']}")
        self.warnings = []

    def stop(self, sid, row_id):
        if sid not in self.stops:
            raise CorrectionError(f"correction {row_id}: stop {sid} does not exist (merged or never exported?)")
        return self.stops[sid]

    def check_old(self, row, stop):
        rid = row["id"]
        if row.get("old_name") and row["old_name"] != stop["station_label"]:
            self.warnings.append(f"correction {rid}: stop {stop['station_id']} is now named "
                                 f"{stop['station_label']!r}, the row expected {row['old_name']!r}")
        if row.get("old_lat") and row.get("old_lng"):
            old = (float(row["old_lat"]), float(row["old_lng"]))
            if distance_m(old, (stop["lat"], stop["lng"])) > COORD_TOLERANCE_M:
                self.warnings.append(f"correction {rid}: stop {stop['station_id']} is now at "
                                     f"{stop['lat']},{stop['lng']}, the row expected {old[0]},{old[1]}")

    def new_coords(self, row):
        if not (row.get("new_lat") and row.get("new_lng")):
            return None
        lat, lng = float(row["new_lat"]), float(row["new_lng"])
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise CorrectionError(f"correction {row['id']}: bad coordinates {lat},{lng}")
        return lat, lng

    def rename(self, stop, label):
        old = stop["station_label"]
        # Keep the old name searchable, unless only spacing or case changed.
        if " ".join(old.lower().split()) != " ".join(label.lower().split()) and old not in stop["alt_names"]:
            stop["alt_names"].append(old)
        stop["station_label"] = label
        taken = {s["station_name"] for s in self.stops.values() if s is not stop}
        slug = slugify(label)
        stop["station_name"] = slug if slug not in taken else f"{slug}-{stop['station_id']}"

    def apply(self, row):
        rid, action = row["id"], row["action"].strip().lower()
        if action not in ACTIONS:
            raise CorrectionError(f"correction {rid}: unknown action {row['action']!r} (use one of {', '.join(ACTIONS)})")
        try:
            sid = int(row["station_id"])
        except ValueError:
            raise CorrectionError(f"correction {rid}: station_id {row['station_id']!r} is not a number") from None
        stop = self.stop(sid, rid)
        if action != "split":
            self.check_old(row, stop)

        if action == "move":
            coords = self.new_coords(row)
            if not coords:
                raise CorrectionError(f"correction {rid}: move needs new_lat and new_lng")
            stop["lat"], stop["lng"] = coords
        elif action == "rename":
            if not row.get("new_name", "").strip():
                raise CorrectionError(f"correction {rid}: rename needs new_name")
            self.rename(stop, row["new_name"].strip())
        elif action == "flag":
            stop["review_note"].append(row.get("reason", "").strip() or "needs review")
        elif action == "merge":
            target = self.stop(int(row["target_id"]), rid)
            if target is stop:
                raise CorrectionError(f"correction {rid}: cannot merge stop {sid} into itself")
            for r in self.line_stops:
                if int(r["station_id"]) == sid:
                    r["station_id"] = str(target["station_id"])
            for name in [stop["station_label"]] + stop["alt_names"]:
                if name != target["station_label"] and name not in target["alt_names"]:
                    target["alt_names"].append(name)
            target["merged_ids"] += [sid] + stop["merged_ids"]
            target["corrections"] += stop["corrections"]
            target["review_note"] += stop["review_note"]
            del self.stops[sid]
            stop = target
        elif action == "split":
            wanted = parse_lines(row.get("lines"))
            if not wanted:
                raise CorrectionError(f"correction {rid}: split needs lines (e.g. L02 or L02:aller)")
            new_id = int(row["target_id"])
            if new_id in self.stops:
                raise CorrectionError(f"correction {rid}: target_id {new_id} is already a stop")
            self.check_old(row, stop)
            moved = 0
            for r in self.line_stops:
                if int(r["station_id"]) == sid and ((r["line_name"], None) in wanted or (r["line_name"], r["direction"]) in wanted):
                    r["station_id"] = str(new_id)
                    moved += 1
            if not moved:
                raise CorrectionError(f"correction {rid}: stop {sid} is not used by {row['lines']}")
            copy = dict(stop, station_id=new_id, alt_names=list(stop["alt_names"]), merged_ids=[],
                        corrections=list(stop["corrections"]), review_note=[])
            self.stops[new_id] = copy
            coords = self.new_coords(row)
            if coords:
                copy["lat"], copy["lng"] = coords
            self.rename(copy, row.get("new_name", "").strip() or stop["station_label"])
            stop["corrections"].append(rid)
            stop = copy
        stop["corrections"].append(rid)

    def outputs(self):
        """Corrected rows for lines.csv, stops.csv and line_stops.csv."""
        seqs = {}
        for r in self.line_stops:
            seqs.setdefault((r["line_id"], r["sens"]), []).append(r)
        line_stops, served = [], {}
        lines_by_id = {l["line_id"]: l for l in self.lines}
        for key in sorted(seqs, key=lambda k: (line_number(lines_by_id[k[0]]["line_name"]), -int(k[1]))):
            rows = sorted(seqs[key], key=lambda r: int(r["stop_sequence"]))
            kept = []
            for r in rows:
                # A merge can put the same stop twice in a row; keep it once.
                if kept and kept[-1]["station_id"] == r["station_id"]:
                    continue
                kept.append(r)
            for i, r in enumerate(kept, 1):
                s = self.stops[int(r["station_id"])]
                lat, lng = coords_text(s)
                line_stops.append(dict(r, stop_sequence=str(i), station_name=s["station_name"],
                                       station_label=s["station_label"], lat=lat, lng=lng))
                served.setdefault(s["station_id"], set()).add(r["line_name"])
            line = lines_by_id[key[0]]
            prefix = "aller" if key[1] == "1" else "retour"
            first, last = self.stops[int(kept[0]["station_id"])], self.stops[int(kept[-1]["station_id"])]
            line.update({f"{prefix}_from": first["station_name"], f"{prefix}_to": last["station_name"],
                         f"{prefix}_stop_count": str(len(kept))})
        stops = []
        for sid in sorted(self.stops):
            s = self.stops[sid]
            names = sorted(served.get(sid, ()), key=line_number)
            lat, lng = coords_text(s)
            stops.append({
                "station_id": sid, "station_name": s["station_name"], "station_label": s["station_label"],
                "lat": lat, "lng": lng, "lines": " ".join(names), "line_count": len(names),
                "alt_names": " | ".join(n for n in s["alt_names"] if n != s["station_label"]), "merged_ids": " ".join(map(str, s["merged_ids"])),
                "corrections": " ".join(dict.fromkeys(s["corrections"])), "review_note": " | ".join(s["review_note"]),
            })
        return self.lines, stops, line_stops


def coords_text(stop):
    """Unmoved stops keep the export's exact text; moved ones get 7 decimals (~1 cm)."""
    src = stop["source_coords"]
    if (float(src[0]), float(src[1])) == (stop["lat"], stop["lng"]):
        return src
    return f"{stop['lat']:.7f}", f"{stop['lng']:.7f}"


def run(source_dir, corrections_csv, out_dir):
    net = Network(source_dir)
    _, rows = read_csv(corrections_csv)
    seen = set()
    for row in rows:
        if not any((v or "").strip() for v in row.values()):
            continue
        if row["id"] in seen:
            raise CorrectionError(f"correction id {row['id']} is used twice")
        seen.add(row["id"])
        net.apply(row)
    lines, stops, line_stops = net.outputs()
    os.makedirs(out_dir, exist_ok=True)
    write_csv(os.path.join(out_dir, "lines.csv"), net.line_fields, lines)
    write_csv(os.path.join(out_dir, "stops.csv"), STOP_FIELDS, stops)
    write_csv(os.path.join(out_dir, "line_stops.csv"), net.ls_fields, line_stops)
    return net, len(seen), stops, line_stops


def main():
    args = sys.argv[1:]
    if len(args) > 3 or any(a in ("-h", "--help") for a in args):
        sys.exit(__doc__)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    defaults = [os.path.join(root, "data", "source"), os.path.join(root, "data", "corrections.csv"), os.path.join(root, "data")]
    source_dir, corrections_csv, out_dir = args + defaults[len(args):]
    try:
        net, applied, stops, line_stops = run(source_dir, corrections_csv, out_dir)
    except CorrectionError as e:
        sys.exit(f"error: {e}")
    for w in net.warnings:
        print(f"warning: {w}", file=sys.stderr)
    print(f"{applied} corrections applied: {len(stops)} stops, {len(line_stops)} line stops written to {out_dir}")


if __name__ == "__main__":
    main()
