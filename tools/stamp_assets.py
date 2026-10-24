"""Add a content version to the app's asset URLs so browsers and proxies
never mix an old cached file with a new deployment.

Usage:  python3 tools/stamp_assets.py <site_dir>

<site_dir> is the finished site (web/ plus data/). The version is a hash of
every file in it. index.html gets "?v=<version>" on its local scripts and
stylesheets, the JavaScript modules on their imports and on the data file
they load, and sw.js gets the version as its cache name. Standard library only.
"""
import hashlib
import os
import re
import sys

LOCAL_REF = re.compile(r'((?:src|href)=")(?!https?:|//|#|data:)([^"?]+\.(?:js|css))(")')
IMPORT = re.compile(r"""((?:from|import)\s*\(?\s*')(\./[^'?]+\.js)(')""")
DATA = re.compile(r"""(')(data/network\.json)(')""")
SW_VERSION = re.compile(r"const VERSION = '[^']*';")


def site_version(site_dir):
    h = hashlib.sha256()
    for root, dirs, files in os.walk(site_dir):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            h.update(os.path.relpath(path, site_dir).replace(os.sep, "/").encode())
            with open(path, "rb") as f:
                h.update(hashlib.sha256(f.read()).digest())
    return h.hexdigest()[:12]


def stamp(text, pattern, version):
    return pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}", text)


def rewrite(path, fn):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    new = fn(text)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(new)
    return new != text


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    site = sys.argv[1]
    version = site_version(site)
    changed = rewrite(os.path.join(site, "index.html"), lambda t: stamp(t, LOCAL_REF, version))
    js_dir = os.path.join(site, "js")
    for name in sorted(os.listdir(js_dir)):
        if name.endswith(".js"):
            rewrite(os.path.join(js_dir, name), lambda t: stamp(stamp(t, IMPORT, version), DATA, version))
    sw = os.path.join(site, "sw.js")
    if not rewrite(sw, lambda t: SW_VERSION.sub(f"const VERSION = '{version}';", t, count=1)):
        sys.exit("sw.js has no VERSION constant to stamp")
    if not changed:
        sys.exit("index.html has no asset references to stamp")
    print(f"assets stamped with version {version}")


if __name__ == "__main__":
    main()
