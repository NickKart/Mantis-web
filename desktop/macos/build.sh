#!/usr/bin/env bash
# Сборка Mantis для macOS (настольное приложение: окно Tauri + встроенный Агент).
#   bash desktop/macos/build.sh             – одна версия для всех Mac (Apple Silicon и Intel) – для раздачи
#   bash desktop/macos/build.sh arm64       – только Apple Silicon (M1 и новее), быстрее – для проверок
#   bash desktop/macos/build.sh x64         – только Intel
# Нужно: Mac с Xcode Command Line Tools, Node 22, Rust (rustup target add aarch64-apple-darwin x86_64-apple-darwin).
# Подпись: по умолчанию ad-hoc ("-" в tauri.conf.json). Для Developer ID задайте APPLE_SIGNING_IDENTITY
# (и для заверения у Apple – APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID): Tauri подхватит их сам.
# Для подписи установщика – APPLE_INSTALLER_IDENTITY («Developer ID Installer: …»).
# Результат в desktop/macos/out/: Mantis-Installer.pkg (мастер установки) и Mantis.dmg (для тех, кто привык к dmg);
# для одной архитектуры – с суффиксом -arm64 / -x64.
set -euo pipefail
cd "$(dirname "$0")/../.."

ARCH="${1:-universal}"
BUN="${BUN:-$(command -v bun || echo node_modules/.bin/bun)}"
FFMPEG_RELEASE="b6.1.1"            # тот же ffmpeg, что у Mantis Агента (agent/build.sh)
VERSION="$(node -p "require('./package.json').version")"
CACHE="agent/.cache"
BIN="desktop/macos/src-tauri/binaries"
OUT="desktop/macos/out"
mkdir -p "$CACHE" agent/build "$BIN" "$OUT"

case "$ARCH" in
  arm64)     TRIPLE="aarch64-apple-darwin";   SUFFIX="-arm64" ;;
  x64)       TRIPLE="x86_64-apple-darwin";    SUFFIX="-x64" ;;
  universal) TRIPLE="universal-apple-darwin"; SUFFIX="" ;;
  *) echo "неизвестная архитектура: $ARCH (universal, arm64 или x64)"; exit 1 ;;
esac

echo "== Страница Mantis"
npm run build --silent
node agent/pack.mjs dist agent/build/assets.bin

echo "== Встроенный Агент ($ARCH)"
# $1 – ffmpeg/bun (darwin-arm64, darwin-x64), $2 – имя файла для Tauri
agent() {
  local ff="$CACHE/ffmpeg-$1"
  if [ ! -s "$ff" ]; then
    curl -fsSL "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffmpeg-$1.gz" | gunzip > "$ff"
  fi
  cp "$ff" agent/build/ffmpeg.bin
  "$BUN" build agent/agent.ts --compile --minify --target="bun-$1" --loader .bin:file --outfile "$BIN/$2" >/dev/null
  rm -f agent/build/ffmpeg.bin
}
case "$ARCH" in
  arm64) agent darwin-arm64 "mantis-agent-$TRIPLE" ;;
  x64)   agent darwin-x64   "mantis-agent-$TRIPLE" ;;
  universal)
    agent darwin-arm64 mantis-agent-aarch64-apple-darwin
    agent darwin-x64   mantis-agent-x86_64-apple-darwin
    lipo -create -output "$BIN/mantis-agent-$TRIPLE" "$BIN/mantis-agent-aarch64-apple-darwin" "$BIN/mantis-agent-x86_64-apple-darwin"
    ;;
esac
ls -lh "$BIN/mantis-agent-$TRIPLE"

echo "== Фон окна установки (.dmg)"
# tauri.conf.json → bundle.macOS.dmg.background; обычная и Retina-картинка в одном файле (desktop/macos/dmg)
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

BUNDLE="desktop/macos/src-tauri/target/$TRIPLE/release/bundle"
cp "$(ls "$BUNDLE"/dmg/*.dmg | head -1)" "$OUT/Mantis$SUFFIX.dmg"

echo "== Установщик"
bash desktop/macos/pkg/make-pkg.sh "$BUNDLE/macos/Mantis.app" "$VERSION" "$OUT/Mantis-Installer$SUFFIX.pkg"
ls -lh "$OUT"
