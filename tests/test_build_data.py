import csv
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import build_data  # noqa: E402


class BuildDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.net = build_data.build(os.path.join(ROOT, "data"))
        cls.stops = {s["id"]: s for s in cls.net["stops"]}
        cls.lines = {l["name"]: l for l in cls.net["lines"]}

    def test_counts_match_csvs(self):
        self.assertEqual(len(self.net["lines"]), 24)
        self.assertEqual(len(self.net["stops"]), len(build_data.read_csv(os.path.join(ROOT, "data", "stops.csv"))))

    def test_every_csv_row_is_kept(self):
        # The corrected CSVs no longer list a stop twice in a row, so nothing is dropped.
        rows = build_data.read_csv(os.path.join(ROOT, "data", "line_stops.csv"))
        kept = sum(len(d["stops"]) for l in self.net["lines"] for d in l["directions"].values())
        self.assertFalse([i for i in self.net["issues"] if i["type"] == "repeated_stop"])
        self.assertEqual(kept, len(rows))

    def test_export_date_comes_from_export_info(self):
        self.assertEqual(self.net["exported"], "2026-10-22")

    def test_names_that_are_not_names(self):
        self.assertTrue(build_data.is_missing_name("2026-07-09 00:00:00"))
        self.assertTrue(build_data.is_missing_name("  "))
        self.assertFalse(build_data.is_missing_name("Place 9 Juillet"))

    def test_merged_stops_redirect_and_keep_their_names(self):
        # Stop 608 ("2026-07-09 00:00:00", i.e. "9 juillet") went into Place 9 Juillet (700),
        # which ISA's review then merged into Bank BMCI (591).
        self.assertEqual(self.net["mergedStops"]["608"], 591)
        self.assertEqual(self.net["mergedStops"]["700"], 591)
        self.assertNotIn(608, self.stops)
        self.assertIn("2026-07-09 00:00:00", self.stops[591]["altNames"])
        self.assertIn("Place 9 Juillet", self.stops[591]["altNames"])
        self.assertFalse(any(i["type"] == "missing_name" for i in self.net["issues"]))

    def test_directions_are_ordered_and_consistent(self):
        for l in self.net["lines"]:
            self.assertEqual(set(l["directions"]), {"aller", "retour"})
            for d in l["directions"].values():
                self.assertEqual(len(d["minutes"]), len(d["stops"]) - 1)
                self.assertTrue(all(m > 0 for m in d["minutes"]))
                for a, b in zip(d["stops"], d["stops"][1:]):
                    self.assertNotEqual(a, b)
                for sid in d["stops"]:
                    self.assertIn(l["id"], self.stops[sid]["lines"])

    def test_first_stop_of_l01_aller(self):
        self.assertEqual(self.lines["L01"]["directions"]["aller"]["stops"][0], 922)

    def test_placeholder_colors_are_replaced_with_distinct_colors(self):
        colors = [l["color"] for l in self.net["lines"]]
        self.assertEqual(len(set(colors)), len(colors))
        self.assertTrue(all(not build_data.is_placeholder_color(c) for c in colors))

    def test_misplaced_stop_was_moved(self):
        # Stop 8 was 18 km north of its neighbours on L08; it now sits next to Aboubeker Kadiri 2.
        s8, s11 = self.stops[8], self.stops[11]
        self.assertLess(build_data.haversine_km((s8["lat"], s8["lng"]), (s11["lat"], s11["lng"])), 0.5)
        self.assertNotIn("suspect_location", s8["flags"])
        # The L31 airport line is genuinely long-distance and not flagged.
        self.assertNotIn("suspect_location", self.stops[507]["flags"])

    def test_line_ends_placed_from_the_figma_map(self):
        # L17's terminus had city-centre coordinates; it now ends the line in Sidi Maafa, unflagged.
        s269, s402 = self.stops[269], self.stops[402]
        self.assertLess(build_data.haversine_km((s269["lat"], s269["lng"]), (s402["lat"], s402["lng"])), 0.5)
        self.assertNotIn("suspect_location", s269["flags"])
        # L02 has its own far terminus; L04 keeps stop 263 north of the centre.
        self.assertEqual(self.lines["L02"]["directions"]["aller"]["stops"][-1], 10263)
        self.assertEqual(self.lines["L04"]["directions"]["aller"]["stops"][0], 263)

    def test_stops_left_for_review_are_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("lines.csv", "stops.csv", "line_stops.csv"):
                shutil.copy(os.path.join(ROOT, "data", name), tmp)
            path = os.path.join(tmp, "stops.csv")
            rows = build_data.read_csv(path)
            next(r for r in rows if r["station_id"] == "269")["review_note"] = "Village Bekay needs a check"
            with open(path, "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
            net = build_data.build(tmp)
        stop = next(s for s in net["stops"] if s["id"] == 269)
        self.assertIn("suspect_location", stop["flags"])
        self.assertTrue(any(i["type"] == "suspect_location" and i["stop"] == 269 and "Village Bekay" in i["detail"]
                            for i in net["issues"]))

    def test_lines_follow_their_road_shapes(self):
        self.assertFalse([i for i in self.net["issues"] if i["type"] == "stale_shape"])
        for l in self.net["lines"]:
            for d in l["directions"].values():
                self.assertEqual(len(d["shapeStops"]), len(d["stops"]))
                first, last = self.stops[d["stops"][0]], self.stops[d["stops"][-1]]
                self.assertLess(build_data.haversine_km(d["shape"][0], (first["lat"], first["lng"])), 0.002)
                self.assertLess(build_data.haversine_km(d["shape"][-1], (last["lat"], last["lng"])), 0.002)
                self.assertGreaterEqual(len(d["shape"]), len(d["stops"]))
        line = build_data.geojson(self.net)["features"][0]
        self.assertEqual(len(line["geometry"]["coordinates"]), len(self.net["lines"][0]["directions"]["aller"]["shape"]))

    def test_display_label(self):
        self.assertEqual(build_data.display_label("TERMUNIS SAHAT NAKHEEL"), "Terminus Sahat Nakheel")
        self.assertEqual(build_data.display_label("auto hall"), "Auto Hall")
        self.assertEqual(build_data.display_label("Av yahya Belkhir"), "Av yahya Belkhir")
        self.assertEqual(build_data.display_label("CAFE DE LA PAIX"), "Cafe de la Paix")
        self.assertEqual(build_data.display_label("PHARMACIE HASSAN II"), "Pharmacie Hassan II")
        self.assertEqual(build_data.display_label("mharach i"), "Mharach I")
        self.assertEqual(build_data.display_label("CHU"), "CHU")
        self.assertEqual(build_data.display_label("bim"), "Bim")

    def test_names_are_in_title_case(self):
        stops = build_data.read_csv(os.path.join(ROOT, "data", "stops.csv"))
        self.assertEqual(next(s["station_label"] for s in stops if s["station_id"] == "810"), "Mosquée Rayan / Qsar Laalaj")
        for s in stops:
            for word in s["station_label"].replace("(", " ").split()[1:]:
                if word not in {"de", "des", "du", "la", "le", "les", "et", "au", "aux", "en", "ou"}:
                    self.assertFalse(re.sub(r"^[dl]'", "", word)[:1].islower(), s["station_label"])

    def test_text_color_contrast(self):
        self.assertEqual(build_data.text_color("#000000"), "#ffffff")
        self.assertEqual(build_data.text_color("#ffffff"), "#000000")

    def test_cli_writes_files(self):
        with tempfile.TemporaryDirectory() as out:
            subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_data.py"), os.path.join(ROOT, "data"), out],
                           check=True, capture_output=True)
            with open(os.path.join(out, "network.geojson"), encoding="utf-8") as f:
                gj = json.load(f)
            self.assertEqual(sum(1 for x in gj["features"] if x["geometry"]["type"] == "Point"), len(self.net["stops"]))
            self.assertEqual(sum(1 for x in gj["features"] if x["geometry"]["type"] == "LineString"), 48)


if __name__ == "__main__":
    unittest.main()
