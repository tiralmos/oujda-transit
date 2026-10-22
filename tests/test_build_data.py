import json
import os
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
        self.assertEqual(len(self.net["stops"]), 698)

    def test_every_csv_row_is_kept_except_consecutive_repeats(self):
        rows = build_data.read_csv(os.path.join(ROOT, "data", "line_stops.csv"))
        repeats = sum(1 for i in self.net["issues"] if i["type"] == "repeated_stop")
        kept = sum(len(d["stops"]) for l in self.net["lines"] for d in l["directions"].values())
        # L17 and L18 each list a stop three times in a row, L01 twice.
        self.assertEqual(repeats, 3)
        self.assertEqual(kept, len(rows) - 5)

    def test_export_date_comes_from_export_info(self):
        self.assertEqual(self.net["exported"], "2026-10-22")

    def test_stop_608_has_no_real_name(self):
        s = self.stops[608]
        self.assertEqual(s["name"], "Stop #608")
        self.assertIn("missing_name", s["flags"])
        self.assertEqual(s["sourceName"], "2026-07-09 00:00:00")

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

    def test_known_misplaced_stop_is_flagged(self):
        # Stop 8 is 18 km from its neighbours on L08.
        self.assertIn("suspect_location", self.stops[8]["flags"])
        # The L31 airport line is genuinely long-distance and not flagged.
        self.assertNotIn("suspect_location", self.stops[507]["flags"])

    def test_display_label(self):
        self.assertEqual(build_data.display_label("TERMUNIS SAHAT NAKHEEL"), "Terminus Sahat Nakheel")
        self.assertEqual(build_data.display_label("auto hall"), "Auto Hall")
        self.assertEqual(build_data.display_label("Av yahya Belkhir"), "Av yahya Belkhir")
        self.assertEqual(build_data.display_label("CAFE DE LA PAIX"), "Cafe de la Paix")

    def test_text_color_contrast(self):
        self.assertEqual(build_data.text_color("#000000"), "#ffffff")
        self.assertEqual(build_data.text_color("#ffffff"), "#000000")

    def test_cli_writes_files(self):
        with tempfile.TemporaryDirectory() as out:
            subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_data.py"), os.path.join(ROOT, "data"), out],
                           check=True, capture_output=True)
            with open(os.path.join(out, "network.geojson"), encoding="utf-8") as f:
                gj = json.load(f)
            self.assertEqual(sum(1 for x in gj["features"] if x["geometry"]["type"] == "Point"), 698)
            self.assertEqual(sum(1 for x in gj["features"] if x["geometry"]["type"] == "LineString"), 48)


if __name__ == "__main__":
    unittest.main()
