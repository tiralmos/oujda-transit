import csv
import filecmp
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import apply_corrections as ac  # noqa: E402

LINES = [
    "line_id,line_name,line_color,aller_from,aller_to,aller_stop_count,retour_from,retour_to,retour_stop_count",
    "1,L01,#000000,a,c,3,c,a,3",
    "2,L02,#000001,b,d,2,d,b,2",
]
STOPS = [
    "station_id,station_name,station_label,lat,lng,lines,line_count",
    "1,a,Stop A,34.680000,-1.910000,L01,1",
    "2,b,Stop B,34.680050,-1.910000,L02,1",
    "3,c,TERMUNIS C,34.690000,-1.900000,L01,1",
    "4,d,Stop D,34.700000,-1.890000,L02,1",
]
LS_HEAD = ("line_id,line_name,direction,sens,headsign,stop_sequence,api_step,station_id,station_name,"
           "station_label,lat,lng,line_station_id")
CORR_HEAD = "id,action,station_id,lines,target_id,old_name,new_name,old_lat,old_lng,new_lat,new_lng,confidence,reason,evidence"


def ls_rows():
    rows = [LS_HEAD]
    seqs = {("1", "L01", "aller", "1"): [1, 2, 3], ("1", "L01", "retour", "0"): [3, 1],
            ("2", "L02", "aller", "1"): [2, 4], ("2", "L02", "retour", "0"): [4, 2]}
    stops = {int(l.split(",")[0]): l.split(",") for l in STOPS[1:]}
    n = 0
    for (lid, name, direction, sens), ids in seqs.items():
        for i, sid in enumerate(ids, 1):
            s = stops[sid]
            n += 1
            rows.append(f"{lid},{name},{direction},{sens},x,{i},{i - 1},{sid},{s[1]},{s[2]},{s[3]},{s[4]},{n}")
    return rows


class ApplyCorrectionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.tmp.name, "source")
        self.out = os.path.join(self.tmp.name, "out")
        os.makedirs(self.src)
        for name, rows in (("lines.csv", LINES), ("stops.csv", STOPS), ("line_stops.csv", ls_rows())):
            with open(os.path.join(self.src, name), "w", encoding="utf-8") as f:
                f.write("\n".join(rows) + "\n")

    def tearDown(self):
        self.tmp.cleanup()

    def run_rows(self, *rows):
        path = os.path.join(self.tmp.name, "corrections.csv")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join((CORR_HEAD,) + rows) + "\n")
        net, _, _, _ = ac.run(self.src, path, self.out)
        read = lambda n: list(csv.DictReader(open(os.path.join(self.out, n), encoding="utf-8-sig")))
        return net, {r["station_id"]: r for r in read("stops.csv")}, read("line_stops.csv"), read("lines.csv")

    def test_no_corrections_keeps_the_export(self):
        _, stops, ls, _ = self.run_rows()
        self.assertEqual(stops["1"]["lat"], "34.680000")
        self.assertEqual(len(ls), len(ls_rows()) - 1)

    def test_move_rename_and_flag(self):
        net, stops, ls, lines = self.run_rows(
            "C1,move,1,,,Stop A,,34.680000,-1.910000,34.681,-1.911,high,why,",
            "C2,rename,3,,,TERMUNIS C,Terminus C,,,,,,typo,",
            "C3,flag,4,,,Stop D,,,,,,,check me,",
            "C4,rename,4,,,Stop D,STOP  D,,,,,,case only,")
        self.assertEqual((stops["1"]["lat"], stops["1"]["lng"]), ("34.6810000", "-1.9110000"))
        self.assertEqual(stops["3"]["station_label"], "Terminus C")
        self.assertEqual(stops["3"]["station_name"], "terminus-c")
        self.assertEqual(stops["3"]["alt_names"], "TERMUNIS C")
        self.assertEqual(stops["4"]["review_note"], "check me")
        self.assertEqual(stops["4"]["alt_names"], "")  # only case and spacing changed
        self.assertEqual(stops["1"]["corrections"], "C1")
        self.assertTrue(all(r["lat"] == "34.6810000" for r in ls if r["station_id"] == "1"))
        self.assertEqual(lines[0]["aller_to"], "terminus-c")
        self.assertEqual(net.warnings, [])

    def test_merge_repoints_lines_and_keeps_the_name(self):
        _, stops, ls, lines = self.run_rows("C1,merge,2,,1,Stop B,,,,,,,close,")
        self.assertNotIn("2", stops)
        self.assertEqual(stops["1"]["lines"], "L01 L02")
        self.assertEqual(stops["1"]["alt_names"], "Stop B")
        self.assertEqual(stops["1"]["merged_ids"], "2")
        self.assertEqual([r["station_id"] for r in ls if r["line_name"] == "L02" and r["direction"] == "aller"], ["1", "4"])
        self.assertEqual(lines[1]["aller_from"], "a")

    def test_merge_collapses_consecutive_repeats(self):
        # L01 aller is 1, 2, 3 once stop 2 is on it; merging 2 into 1 gives 1, 3.
        _, stops, ls, lines = self.run_rows("C1,merge,1,,2,Stop A,,,,,,,,")
        aller = [r for r in ls if r["line_name"] == "L01" and r["direction"] == "aller"]
        self.assertEqual([r["station_id"] for r in aller], ["2", "3"])
        self.assertEqual([r["stop_sequence"] for r in aller], ["1", "2"])
        self.assertEqual(lines[0]["aller_stop_count"], "2")

    def test_split_gives_one_line_its_own_stop(self):
        _, stops, ls, _ = self.run_rows("C1,split,2,L02:retour,10002,Stop B,Stop B south,,,34.6,-1.9,,,")
        self.assertEqual(stops["10002"]["station_label"], "Stop B south")
        self.assertEqual(stops["10002"]["lines"], "L02")
        self.assertEqual(stops["2"]["lines"], "L01 L02")
        ids = {(r["direction"], r["station_id"]) for r in ls if r["line_name"] == "L02"}
        self.assertIn(("retour", "10002"), ids)
        self.assertIn(("aller", "2"), ids)

    def test_stale_rows_warn(self):
        net, _, _, _ = self.run_rows("C1,move,1,,,Old name,,34.0,-1.0,34.681,-1.911,,,")
        self.assertEqual(len(net.warnings), 2)

    def test_bad_rows_fail_with_the_row_id(self):
        for row, msg in (("C9,merge,99,,1,,,,,,,,,", "C9"), ("C9,teleport,1,,,,,,,,,,,", "unknown action"),
                         ("C9,move,1,,,,,,,,,,,", "new_lat"), ("C9,split,1,L02,10001,,,,,,,,,", "not used by")):
            with self.subTest(row=row), self.assertRaisesRegex(ac.CorrectionError, msg):
                self.run_rows(row)

    def test_repository_data_matches_its_corrections(self):
        # data/*.csv must be exactly what the corrections produce from the raw export.
        ac.run(os.path.join(ROOT, "data", "source"), os.path.join(ROOT, "data", "corrections.csv"), self.out)
        for name in ("lines.csv", "stops.csv", "line_stops.csv"):
            with self.subTest(name=name):
                self.assertTrue(filecmp.cmp(os.path.join(ROOT, "data", name), os.path.join(self.out, name), shallow=False),
                                f"data/{name} is out of date: run python3 tools/apply_corrections.py")


if __name__ == "__main__":
    unittest.main()
