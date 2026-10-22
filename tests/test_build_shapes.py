import csv
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import build_shapes  # noqa: E402

LS_HEAD = "line_id,line_name,direction,sens,headsign,stop_sequence,api_step,station_id,station_name,station_label,lat,lng,line_station_id"


class FakeRouter:
    """Stands in for OSRM: each leg goes through the given detour point, if any, else a midpoint."""

    def __init__(self, detours=None):
        self.detours = detours or {}

    def legs(self, pts, u_turns):
        out = []
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            via = self.detours.get(i) if not u_turns or i not in self.detours.get("only_without", ()) else None
            out.append([a, via or ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), b])
        return out


class BuildShapesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        rows = [LS_HEAD]
        for i, (sid, lat) in enumerate([(1, 34.680), (2, 34.682), (3, 34.684)], 1):
            rows.append(f"1,L01,aller,1,x,{i},{i - 1},{sid},s{sid},S{sid},{lat},-1.910,{i}")
        with open(os.path.join(self.dir, "line_stops.csv"), "w", encoding="utf-8") as f:
            f.write("\n".join(rows) + "\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_legs_start_and_end_on_the_stops(self):
        rows, report = build_shapes.build(self.dir, FakeRouter())
        stops = [r for r in rows if r[4]]
        self.assertEqual([r[4] for r in stops], ["1", "2", "3"])
        self.assertEqual([r[5] for r in stops], ["road", "road", ""])
        self.assertEqual((stops[0][6], stops[0][7]), ("34.680000", "-1.910000"))
        self.assertEqual([r[2] for r in rows], list(range(len(rows))))
        self.assertEqual(report, [])

    def test_gross_detour_is_drawn_straight(self):
        rows, report = build_shapes.build(self.dir, FakeRouter({0: (34.70, -1.95)}))
        self.assertEqual(rows[0][5], "straight")
        self.assertEqual(rows[1][4], "2")  # nothing between stop 1 and stop 2
        self.assertEqual(len(report), 1)

    def test_the_shorter_of_the_two_routings_is_kept(self):
        # Without u-turns the first leg loops far away; with them it is direct.
        rows, _ = build_shapes.build(self.dir, FakeRouter({0: (34.70, -1.95), "only_without": (0,)}))
        self.assertEqual(rows[0][5], "road")

    def test_long_way_round_follows_the_map_when_it_is_shorter(self):
        os.makedirs(os.path.join(self.dir, "source"))
        with open(os.path.join(self.dir, "source", "figma_routes.geojson"), "w", encoding="utf-8") as f:
            f.write('{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"line":"L01"},'
                    '"geometry":{"type":"LineString","coordinates":[[-1.9101,34.679],[-1.9101,34.685]]}}]}')
        # 1.5 km loop for a 220 m leg: not gross enough to be drawn straight, but the map is shorter.
        rows, report = build_shapes.build(self.dir, FakeRouter({0: (34.681, -1.9165)}))
        self.assertEqual(rows[0][5], "map")
        self.assertIn("Figma", report[0])

    def test_simplify_drops_points_on_a_straight_road(self):
        pts = [(34.68 + i * 0.0001, -1.91) for i in range(10)]
        self.assertEqual(build_shapes.simplify(pts), [pts[0], pts[-1]])
        bent = pts[:5] + [(34.6805, -1.909)] + pts[5:]
        self.assertIn((34.6805, -1.909), build_shapes.simplify(bent))

    def test_repository_shapes_match_the_stops(self):
        # Every line direction has a shape whose stop rows are its stops, in order and in place.
        shapes = {}
        with open(os.path.join(ROOT, "data", "shapes.csv"), encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r["station_id"]:
                    shapes.setdefault((r["line_name"], r["direction"]), []).append((r["station_id"], r["lat"], r["lng"]))
        stops = {}
        for (line, direction), seq in build_shapes.directions(os.path.join(ROOT, "data")).items():
            stops[(line, direction)] = [(sid, f"{p[0]:.6f}", f"{p[1]:.6f}") for _, sid, p in seq]
        self.assertEqual(shapes, stops, "data/shapes.csv is out of date: run python3 tools/build_shapes.py")


if __name__ == "__main__":
    unittest.main()
