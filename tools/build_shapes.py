#!/usr/bin/env python3
"""Draw each line along the roads: route between consecutive stops and write data/shapes.csv.

    python3 tools/build_shapes.py [data_dir] [--cache DIR]

Routes come from the public OSRM demo server (OpenStreetMap roads, car profile), one request per
line direction, at most one request a second. A leg whose road route is much longer than the
straight line between its two stops (a wrong snap, a one-way loop) is drawn straight instead and
reported. Re-run this after the stops change; a test fails if the shapes no longer match the stops.

A bus drives one forward path: it never turns back at a stop, and each stop is reached on the side
of the road the bus is driving on (OSRM bearings: the direction of travel from the previous stop to
the next one). On a divided road a stop drawn on the other carriageway is therefore served from the
bus's own carriageway, without a detour to the marker. When the route is still a long way round,
the leg follows ISA's hand-drawn Figma map instead if the map is clearly shorter
(data/source/figma_routes.geojson); a gross detour is drawn straight.

shapes.csv has one row per point. The rows of a stop carry its stop_sequence, station_id and how
the leg that starts there is drawn (road, map or straight), at the point on the road where the bus
stops (at most SNAP_M from the stop; further away the stop itself is used); the points between two
stops have them blank.
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
SNAP_M = 40
BEARING_TOLERANCE = 90
FIELDS = ["line_name", "direction", "point", "stop_sequence", "station_id", "leg", "lat", "lng"]


def haversine_m(a, b):
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def bearing(a, b):
    """Compass heading from a to b in degrees (0 = north)."""
    la1, la2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    x = math.sin(dl) * math.cos(la2)
    y = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return math.degrees(math.atan2(x, y)) % 360


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

    def legs(self, pts):
        """Road route through the points without turning back at any of them.

        Returns (legs, snapped): the road geometry of each leg between consecutive points
        ([[(lat, lng), ...], ...]) and where each point was put on the road ([(lat, lng), ...])."""
        legs, snapped = [], []
        for start in range(0, len(pts) - 1, MAX_WAYPOINTS - 1):
            chunk = pts[start:start + MAX_WAYPOINTS]
            heads = [bearing(chunk[max(i - 1, 0)], chunk[min(i + 1, len(chunk) - 1)]) for i in range(len(chunk))]
            if start:  # the chunk's first point continues the previous chunk's travel
                heads[0] = bearing(pts[start - 1], pts[start + 1])
            coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in chunk)
            base = f"{OSRM}{coords}?overview=false&steps=true&geometries=geojson&continue_straight=true"
            data = self.fetch(base + "&bearings=" + ";".join(f"{h:.0f},{BEARING_TOLERANCE}" for h in heads))
            if data.get("code") != "Ok":
                # No road heading that way near some stop: let OSRM pick the nearest road.
                data = self.fetch(base)
            if data.get("code") != "Ok":
                raise RuntimeError(f"OSRM: {data.get('code')} {data.get('message', '')}")
            for leg in data["routes"][0]["legs"]:
                geo = []
                for step in leg["steps"]:
                    for lng, lat in step["geometry"]["coordinates"]:
                        if not geo or geo[-1] != (lat, lng):
                            geo.append((lat, lng))
                legs.append(geo)
            wps = [(lat, lng) for lng, lat in (w["location"] for w in data["waypoints"])]
            snapped += wps if not start else wps[1:]
        return legs, snapped


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


def load_vias(data_dir):
    """Points a leg must pass through, from data/source/shape_vias.csv:
    {(line_name, direction, from_station, to_station): [(lat, lng), ...]}."""
    path = os.path.join(data_dir, "source", "shape_vias.csv")
    out = {}
    if os.path.exists(path):
        for r in read_csv(path):
            key = (r["line_name"], r["direction"], r["from_station"], r["to_station"])
            out.setdefault(key, []).append((float(r["lat"]), float(r["lng"])))
    return out


def route_stops(router, stops, vias):
    """Road legs between consecutive stops (through their via points) and each stop's road position."""
    pts, is_stop = [], []
    for i, (_, sid, p) in enumerate(stops):
        pts.append(p)
        is_stop.append(True)
        if i + 1 < len(stops):
            for v in vias.get((sid, stops[i + 1][1]), []):
                pts.append(v)
                is_stop.append(False)
    legs, snapped = router.legs(pts)
    out_legs, out_snapped = [], []
    for k, (geo, stop) in enumerate(zip(legs + [None], is_stop)):
        if stop:
            out_snapped.append(snapped[k])
            if geo is not None:
                out_legs.append(list(geo))
        elif geo is not None:
            out_legs[-1] += geo[1:] if out_legs[-1] and geo and out_legs[-1][-1] == geo[0] else geo
    return out_legs, out_snapped


def drop_spurs(router, legs, at, stops):
    """A bus does not drive up to a stop and come back out the way it came: when going straight from
    the previous stop to the next one passes within SNAP_M of a stop and is clearly shorter, use that
    and stop the bus where it passes. Returns the stop indices it changed."""
    changed = []
    for i in range(1, len(stops) - 1):
        via = path_m([at[i - 1]] + legs[i - 1] + [at[i]]) + path_m([at[i]] + legs[i] + [at[i + 1]])
        if via < 1.2 * (haversine_m(at[i - 1], at[i]) + haversine_m(at[i], at[i + 1])) + 60:
            continue  # no real spur at this stop
        (direct,), _ = router.legs([at[i - 1], at[i + 1]])
        direct = [at[i - 1]] + direct + [at[i + 1]]
        dist, along, foot = project(direct, stops[i][2])
        if dist > SNAP_M or path_m(direct) > via - 60:
            continue
        legs[i - 1], legs[i] = cut(direct, 0, along)[1:-1], cut(direct, along, float("inf"))[1:-1]
        at[i] = foot
        changed.append(i)
    return changed


def build(data_dir, router):
    figma = load_figma(data_dir)
    vias = load_vias(data_dir)
    rows, report = [], []
    for (line, direction), stops in sorted(directions(data_dir).items()):
        legs, snapped = route_stops(router, stops, {(a, b): v for (l, d, a, b), v in vias.items()
                                                    if (l, d) == (line, direction)})
        # Where the bus stops: on its road next to the stop, not across a divided road at the marker.
        at = [w if haversine_m(w, p) <= SNAP_M else p for w, (_, _, p) in zip(snapped, stops)]
        for i in drop_spurs(router, legs, at, stops):
            report.append(f"{line} {direction} stop {stops[i][0]} ({stops[i][1]}): served from the passing road, "
                          f"no detour to the stop")
        n = 0
        for i, (seq, sid, _) in enumerate(stops):
            p = at[i]
            if i == len(stops) - 1:
                rows.append([line, direction, n, seq, sid, "", f"{p[0]:.6f}", f"{p[1]:.6f}"])
                break
            q = at[i + 1]
            straight_m = haversine_m(p, q)
            road = [p] + legs[i] + [q]
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
