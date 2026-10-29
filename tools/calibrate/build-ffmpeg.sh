#!/usr/bin/env bash
# Build a native FFmpeg matching the version and code paths of the ffmpeg.wasm core
# (@ffmpeg/core 0.12.x = FFmpeg n5.1.4, compiled with --disable-asm).
# palettegen/paletteuse/gif output is deterministic C, so a native build with asm
# disabled produces the same GIF sizes as the browser build, much faster.
#
# Usage: ./build-ffmpeg.sh [build-dir]    (default: tools/calibrate/.cache)
set -euo pipefail
VERSION=5.1.4
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${1:-$HERE/.cache}
mkdir -p "$DIR"
cd "$DIR"
[ -f ffmpeg-$VERSION.tar.xz ] || curl -fsSLO https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz
[ -d ffmpeg-$VERSION ] || tar -xJf ffmpeg-$VERSION.tar.xz
cd ffmpeg-$VERSION
# Newer GCCs turn some old warnings into errors; FFmpeg 5.1 predates that.
./configure --prefix="$DIR/ffmpeg-$VERSION-install" \
  --enable-gpl --disable-asm --disable-autodetect --disable-doc \
  --disable-ffplay --disable-network \
  --extra-cflags="-Wno-error=incompatible-pointer-types -Wno-error=int-conversion -Wno-error=implicit-function-declaration" \
  > configure.log
make -j"$(nproc)" > make.log 2>&1
make install > /dev/null
echo "$DIR/ffmpeg-$VERSION-install/bin/ffmpeg"
