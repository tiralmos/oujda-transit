#!/usr/bin/env python3
"""Draw each line along the roads: route between consecutive stops and write data/shapes.csv.

    python3 tools/build_shapes.py [data_dir] [--cache DIR]

Routes come from the public OSRM demo server (OpenStreetMap roads, car profile), one request per
line direction, at most one request a second. A leg whose road route is much longer than the
straight line between its two stops (a wrong snap, a one-way loop) is drawn straight instead and
reported. Re-run this after the stops change; a test fails if the shapes no longer match the stops.

Each leg is routed twice (with and without turning back at stops) and the shorter is kept. When
that is still a long way round, the leg follows ISA's hand-drawn Figma map instead if the map is
clearly shorter (data/source/figma_routes.geojson); a gross detour is drawn straight.

shapes.csv has one row per point. The rows of a stop carry its stop_sequence, station_id and how
the leg that starts there is drawn (road, map or straight); the points between two stops have them
blank.
"""
import csv
import hashlib
import json
import math
import os
import sys
import time
import urllib.request

OSRM = "https://router.project-osrm.org/route/v1/driving/"
UA = "oujda-transit/1.0 (github.com/tiralmos/oujda-transit)"
MAX_WAYPOINTS = 50
SIMPLIFY_M = 4
FIELDS = ["line_name", "direction", "point", "stop_sequence", "station_id", "leg", "lat", "lng"]


def haversine_m(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def path_m(pts):
    return sum(haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def is_detour(road_m, straight_m):
    # Buses do loop around blocks, so only a gross detour counts.
    return road_m > 2.5 * straight_m + 400


def simplify(pts, tol_m=SIMPLIFY_M):
    """Douglas-Peucker on a local flat projection, keeping both ends."""
    if len(pts) < 3:
        return list(pts)
    kx = 111320 * math.cos(math.radians(pts[0][0]))
    xy = [((p[1] - pts[0][1]) * kx, (p[0] - pts[0][0]) * 110540) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = xy[i], xy[j]
        dx, dy = bx - ax, by - ay
        n = math.hypot(dx, dy)
        best, k = 0, None
        for m in range(i + 1, j):
            px, py = xy[m]
            d = abs(dy * (px - ax) - dx * (py - ay)) / n if n else math.hypot(px - ax, py - ay)
            if d > best:
                best, k = d, m
        if k is not None and best > tol_m:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [p for p, kept in zip(pts, keep) if kept]


class Router:
    def __init__(self, cache=None):
        self.cache, self.last = cache, 0.0
        if cache:
            os.makedirs(cache, exist_ok=True)

    def fetch(self, url):
        key = self.cache and os.path.join(self.cache, hashlib.sha1(url.encode()).hexdigest() + ".json")
        if key and os.path.exists(key):
            with open(key, encoding="utf-8") as f:
                return json.load(f)
        time.sleep(max(0.0, 1.0 - (time.time() - self.last)))
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                body = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
                break
            except OSError:
                if attempt == 3:
                    raise
                time.sleep(2 ** (attempt + 1))
        self.last = time.time()
        data = json.loads(body)
        if key and data.get("code") == "Ok":
            with open(key, "w", encoding="utf-8") as f:
                f.write(body)
        return data

    def legs(self, pts, u_turns):
        """Road geometry of each leg between consecutive points: [[(lat, lng), ...], ...].

        With u_turns the bus may turn back at a stop; without, it must carry on and loop round."""
        out = []
        extra = "&continue_straight=false" if u_turns else "&continue_straight=true"
        for start in range(0, len(pts) - 1, MAX_WAYPOINTS - 1):
            chunk = pts[start:start + MAX_WAYPOINTS]
            coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in chunk)
            data = self.fetch(f"{OSRM}{coords}?overview=false&steps=true&geometries=geojson{extra}")
            if data.get("code") != "Ok":
                raise RuntimeError(f"OSRM: {data.get('code')} {data.get('message', '')}")
            for leg in data["routes"][0]["legs"]:
                geo = []
                for step in leg["steps"]:
                    for lng, lat in step["geometry"]["coordinates"]:
                        if not geo or geo[-1] != (lat, lng):
                            geo.append((lat, lng))
                out.append(geo)
        return out


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def directions(data_dir):
    """{(line_name, direction): [(stop_sequence, station_id, (lat, lng)), ...]} in route order."""
    out = {}
    for r in read_csv(os.path.join(data_dir, "line_stops.csv")):
        out.setdefault((r["line_name"], r["direction"]), []).append(
            (int(r["stop_sequence"]), r["station_id"], (float(r["lat"]), float(r["lng"]))))
    for stops in out.values():
        stops.sort()
    return out


def load_figma(data_dir):
    """Hand-drawn routes from ISA's Figma map: {line_name: [[(lat, lng), ...], ...]}."""
    path = os.path.join(data_dir, "source", "figma_routes.geojson")
    out = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for feat in json.load(f)["features"]:
                pts = [(lat, lng) for lng, lat in feat["geometry"]["coordinates"]]
                out.setdefault(feat["properties"]["line"], []).append(pts)
    return out


def project(path, p):
    """(distance to the path in m, distance along it in m, point) of p's closest point on path."""
    best, along = None, 0.0
    kx = 111320 * math.cos(math.radians(p[0]))
    for a, b in zip(path, path[1:]):
        ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * 110540
        bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * 110540
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        t = 0.0 if seg == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (seg * seg)))
        d = math.hypot(ax + t * dx, ay + t * dy)
        if best is None or d < best[0]:
            best = (d, along + t * seg, (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
        along += seg
    return best


def cut(path, start_m, end_m):
    """The part of path between two distances along it, in the order start -> end."""
    if start_m > end_m:
        return list(reversed(cut(path, end_m, start_m)))
    out, along = [], 0.0
    kx = 111320 * math.cos(math.radians(path[0][0]))
    for a, b in zip(path, path[1:]):
        seg = math.hypot((b[1] - a[1]) * kx, (b[0] - a[0]) * 110540)
        if along + seg >= start_m and along <= end_m and seg > 0:
            for m in (max(start_m, along), min(end_m, along + seg)):
                t = (m - along) / seg
                q = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
                if not out or out[-1] != q:
                    out.append(q)
        along += seg
    return out


def figma_leg(paths, p, q, near_m=60):
    """The hand-drawn route between two stops, when both are close to the same drawn path."""
    best = None
    for path in paths:
        a, b = project(path, p), project(path, q)
        if a[0] <= near_m and b[0] <= near_m:
            part = cut(path, a[1], b[1])
            if len(part) >= 2 and (best is None or path_m(part) < path_m(best)):
                best = part
    return best


def build(data_dir, router):
    figma = load_figma(data_dir)
    rows, report = [], []
    for (line, direction), stops in sorted(directions(data_dir).items()):
        pts = [p for _, _, p in stops]
        variants = [router.legs(pts, u_turns=True), router.legs(pts, u_turns=False)]
        n = 0
        for i, (seq, sid, p) in enumerate(stops):
            if i == len(stops) - 1:
                rows.append([line, direction, n, seq, sid, "", f"{p[0]:.6f}", f"{p[1]:.6f}"])
                break
            q = stops[i + 1][2]
            straight_m = haversine_m(p, q)
            # The leg starts and ends on the stops themselves so the line meets their markers.
            road = min(([p] + v[i] + [q] for v in variants), key=path_m)
            kind = "road"
            if path_m(road) > 1.6 * straight_m + 150:
                # A long way round is often a one-way street or a stop snapped to the wrong road:
                # follow ISA's map there when it is clearly shorter.
                drawn = figma_leg(figma.get(line, []), p, q)
                if drawn and path_m([p] + drawn + [q]) < 0.8 * path_m(road):
                    road, kind = [p] + drawn + [q], "map"
            leg_ref = f"{line} {direction} {seq}->{stops[i + 1][0]} ({sid}->{stops[i + 1][1]})"
            if is_detour(path_m(road), straight_m):
                report.append(f"{leg_ref}: road {path_m(road):.0f} m vs straight {straight_m:.0f} m, drawn straight")
                road, kind = [p, q], "straight"
            elif kind == "map":
                report.append(f"{leg_ref}: drawn from the Figma map ({path_m(road):.0f} m)")
            leg = simplify(road)
            rows.append([line, direction, n, seq, sid, kind, f"{p[0]:.6f}", f"{p[1]:.6f}"])
            n += 1
            for lat, lng in leg[1:-1]:
                rows.append([line, direction, n, "", "", "", f"{lat:.6f}", f"{lng:.6f}"])
                n += 1
    return rows, report


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    cache = argv[argv.index("--cache") + 1] if "--cache" in argv else None
    if cache in args:
        args.remove(cache)
    data_dir = args[0] if args else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
    rows, report = build(data_dir, Router(cache))
    with open(os.path.join(data_dir, "shapes.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(FIELDS)
        w.writerows(rows)
    print(f"{len(rows)} points written to {os.path.join(data_dir, 'shapes.csv')}")
    for line in report:
        print("  " + line)


if __name__ == "__main__":
    main(sys.argv[1:])
