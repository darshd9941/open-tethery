#!/usr/bin/env bash
# Host-side unit tests for the pure parts of the Transmit plugin (no Windows, no SDK).
#   native/transmit/test/run.sh
# Needs g++ (C++17) and node (for the golden-bytes check against helper/lib/otx1.js).
# Optional: SDK_HEADERS=/path/to/Headers also runs a mingw-w64 syntax check of the plugin sources.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${TMPDIR:-/tmp}/otx-transmit-test.$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
CXX="${CXX:-g++}"
FLAGS="-std=c++17 -O1 -Wall -Wextra -pthread"

for t in test_audio test_otx test_h264; do
  [ -f "$here/$t.cpp" ] || continue
  "$CXX" $FLAGS "$here/$t.cpp" -o "$out/$t"
done

"$out/test_audio"
"$out/test_otx" "$out/golden.bin"
node "$here/check_golden.js" "$out/golden.bin"
[ -x "$out/test_h264" ] && "$out/test_h264"

if [ -n "${SDK_HEADERS:-}" ] && command -v x86_64-w64-mingw32-g++ >/dev/null; then
  for f in PocketMonitorTransmit FrameSender JpegEncoder H264Encoder; do
    [ -f "$here/../src/$f.cpp" ] || continue
    x86_64-w64-mingw32-g++ -std=c++17 -w -fsyntax-only -DPRWIN_ENV -DWIN32 -D_WINDOWS \
      -I"$SDK_HEADERS" "$here/../src/$f.cpp"
    echo "mingw syntax check: $f ok"
  done
fi
echo "all native/transmit tests passed"
