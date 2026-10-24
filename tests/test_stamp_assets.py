import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class StampAssetsTest(unittest.TestCase):
    def stamp(self):
        site = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, site)
        shutil.copytree(os.path.join(ROOT, "web"), site, dirs_exist_ok=True)
        out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "stamp_assets.py"), site],
                             check=True, capture_output=True, text=True).stdout
        version = out.strip().rsplit(" ", 1)[-1]
        read = lambda *p: open(os.path.join(site, *p), encoding="utf-8").read()  # noqa: E731
        return site, version, read

    def test_every_local_asset_and_import_is_versioned(self):
        _, version, read = self.stamp()
        self.assertRegex(version, r"^[0-9a-f]{12}$")
        index = read("index.html")
        for ref in ("css/app.css", "js/app.js", "js/theme-init.js", "config.js", "vendor/leaflet/leaflet.js"):
            self.assertIn(f"{ref}?v={version}\"", index)
        for name in os.listdir(os.path.join(ROOT, "web", "js")):
            text = read("js", name)
            for line in text.splitlines():
                if line.startswith("import ") and " from './" in line:
                    self.assertIn(f".js?v={version}'", line, f"{name}: {line}")
        self.assertIn(f"'data/network.json?v={version}'", read("js", "app.js"))
        self.assertIn(f"const VERSION = '{version}';", read("sw.js"))

    def test_version_follows_content(self):
        _, v1, _ = self.stamp()
        _, v2, _ = self.stamp()
        self.assertEqual(v1, v2)


if __name__ == "__main__":
    unittest.main()
