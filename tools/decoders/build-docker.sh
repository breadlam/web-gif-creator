#!/usr/bin/env bash
# Build public/decoders/decoder.{mjs,wasm} in the pinned Emscripten image.
# The output is committed, so GitHub Pages doesn't need this toolchain.
set -euo pipefail
FFMPEG_VERSION=8.1.3
EMSDK_IMAGE=emscripten/emsdk:6.0.12

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
CACHE=$HERE/.cache
mkdir -p "$CACHE" "$ROOT/public/decoders"
# SHA-256 of the release tarball from ffmpeg.org (checked when first pinned).
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
[ -f "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" ] ||
  curl -fsSL -o "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
echo "$FFMPEG_SHA256  $CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" | sha256sum -c --quiet

docker run --rm -u "$(id -u):$(id -g)" \
  -v "$HERE:/src:ro" -v "$CACHE:/build" -v "$ROOT/public/decoders:/out" \
  "$EMSDK_IMAGE" bash /src/build.sh
