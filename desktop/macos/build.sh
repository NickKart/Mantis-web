#!/usr/bin/env bash
# Сборка Mantis для macOS (настольное приложение: окно Tauri + встроенный Агент).
#   bash desktop/macos/build.sh arm64   – Apple Silicon (M1 и новее)
#   bash desktop/macos/build.sh x64     – Intel
# Нужно: Mac с Xcode Command Line Tools, Node 22, Rust (rustup target add aarch64-apple-darwin x86_64-apple-darwin).
# Подпись: по умолчанию ad-hoc ("-" в tauri.conf.json). Для Developer ID задайте APPLE_SIGNING_IDENTITY
# (и для заверения у Apple – APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID): Tauri подхватит их сам.
# Результат: desktop/macos/out/Mantis-macOS-<arch>.dmg
set -euo pipefail
cd "$(dirname "$0")/../.."

ARCH="${1:-arm64}"
BUN="${BUN:-$(command -v bun || echo node_modules/.bin/bun)}"
FFMPEG_RELEASE="b6.1.1"            # тот же ffmpeg, что у Mantis Агента (agent/build.sh)
VERSION="$(node -p "require('./package.json').version")"
CACHE="agent/.cache"
BIN="desktop/macos/src-tauri/binaries"
OUT="desktop/macos/out"
mkdir -p "$CACHE" agent/build "$BIN" "$OUT"

case "$ARCH" in
  arm64) FF="darwin-arm64"; TRIPLE="aarch64-apple-darwin" ;;
  x64)   FF="darwin-x64";   TRIPLE="x86_64-apple-darwin" ;;
  *) echo "неизвестная архитектура: $ARCH (arm64 или x64)"; exit 1 ;;
esac

echo "== Страница Mantis"
npm run build --silent
node agent/pack.mjs dist agent/build/assets.bin

echo "== Встроенный Агент ($ARCH)"
ff="$CACHE/ffmpeg-$FF"
if [ ! -s "$ff" ]; then
  curl -fsSL "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffmpeg-$FF.gz" | gunzip > "$ff"
fi
cp "$ff" agent/build/ffmpeg.bin
"$BUN" build agent/agent.ts --compile --minify --target="bun-$FF" --loader .bin:file --outfile "$BIN/mantis-agent-$TRIPLE" >/dev/null
rm -f agent/build/ffmpeg.bin
ls -lh "$BIN/mantis-agent-$TRIPLE"

echo "== Фон окна установки (.dmg)"
# обычная и Retina-картинка в одном файле – Finder сам выберет нужную
if command -v tiffutil >/dev/null 2>&1; then
  tiffutil -cathidpicheck desktop/macos/dmg/background.png desktop/macos/dmg/background@2x.png -out desktop/macos/dmg/background.tiff
else
  cp desktop/macos/dmg/background.png desktop/macos/dmg/background.tiff
fi

echo "== Приложение"
cd desktop/macos
npm ci --silent
npx tauri build --target "$TRIPLE" --bundles app,dmg --config "{\"version\":\"$VERSION\"}"
cd ../..

dmg="$(ls desktop/macos/src-tauri/target/$TRIPLE/release/bundle/dmg/*.dmg | head -1)"
cp "$dmg" "$OUT/Mantis-macOS-$ARCH.dmg"
ls -lh "$OUT"
