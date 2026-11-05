#!/bin/sh
# Validates a GTFS feed with MobilityData's validator (the reference used by Google Maps,
# Transitland and others). Needs Java 17+ and Maven.
#   tools/gtfs-validator/validate.sh [feed.zip] [report folder]
# Defaults: gtfs/oujda-gtfs.zip and gtfs/report. Exits 1 if the feed has errors.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
feed=${1:-gtfs/oujda-gtfs.zip}
report=${2:-gtfs/report}
build="$here/.build"

if [ ! -f "$build/Validate.class" ]; then
  mvn -q -B -f "$here/pom.xml" dependency:copy-dependencies -DoutputDirectory="$build/lib"
  javac -cp "$build/lib/*" -d "$build" "$here/Validate.java"
fi

rm -rf "$report"
mkdir -p "$report"
java -cp "$build/lib/*:$build" Validate "$feed" "$report" > "$report/validator.log" 2>&1 || true
[ -f "$report/report.json" ] || { cat "$report/validator.log" >&2; exit 2; }
node -e '
const r = require(require("path").resolve(process.argv[1], "report.json"));
const counts = { ERROR: 0, WARNING: 0, INFO: 0 };
for (const n of r.notices) { counts[n.severity] += n.totalNotices; console.log(`${n.severity.padEnd(7)} ${n.code} (${n.totalNotices})`); }
console.log(`${counts.ERROR} errors, ${counts.WARNING} warnings, ${counts.INFO} infos. Full report: ${process.argv[1]}/report.html`);
process.exit(counts.ERROR ? 1 : 0);
' "$report"
