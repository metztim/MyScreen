#!/bin/bash
# Builds the transcription engine MyScreen ships: whisper.cpp's command-line
# tool as one self-contained binary (static, Metal shaders embedded), from a
# pinned release of the official source. Output: vendor-bin/whisper-cli,
# which electron-builder copies into the app (package.json extraResources).
#
# Needs git and cmake. Re-run after changing WHISPER_VERSION.
set -euo pipefail

WHISPER_VERSION="v1.9.5"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.cache/whisper.cpp-$WHISPER_VERSION"
OUT="$ROOT/vendor-bin"
STAMP="$OUT/whisper-cli.version"

if [ -x "$OUT/whisper-cli" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$WHISPER_VERSION" ]; then
  echo "whisper-cli $WHISPER_VERSION already built"
  exit 0
fi

if [ ! -d "$SRC" ]; then
  git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp.git "$SRC"
fi

cmake -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DGGML_NATIVE=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_SDL2=OFF
cmake --build "$SRC/build" --target whisper-cli --config Release -j

mkdir -p "$OUT"
cp "$SRC/build/bin/whisper-cli" "$OUT/whisper-cli"
strip -x "$OUT/whisper-cli"
echo "$WHISPER_VERSION" > "$STAMP"
echo "built $OUT/whisper-cli"
