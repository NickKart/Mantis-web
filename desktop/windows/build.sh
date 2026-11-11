#!/usr/bin/env bash
# Сборка Mantis для Windows (настольное приложение: окно Tauri + встроенный Агент) и установщика.
#   bash desktop/windows/build.sh
# Запускать на Windows в Git Bash (так делает GitHub Actions). Нужно: Node 22, Bun ≥ 1.4, Rust (MSVC), Visual Studio Build Tools.
# Результат: desktop/windows/out/Mantis-Setup.exe – мастер установки «Далее → Установить», без прав администратора
# (ставится в папку пользователя, ярлыки в «Пуске» и на рабочем столе). WebView2 доустановится сам, если его нет.
set -euo pipefail
cd "$(dirname "$0")/../.."

BUN="${BUN:-$(command -v bun || echo node_modules/.bin/bun)}"
FFMPEG_RELEASE="b6.1.1"            # тот же ffmpeg, что у Mantis Агента (agent/build.sh)
VERSION="$(node -p "require('./package.json').version")"
TRIPLE="x86_64-pc-windows-msvc"
CACHE="agent/.cache"
BIN="desktop/windows/src-tauri/binaries"
OUT="desktop/windows/out"
mkdir -p "$CACHE" agent/build "$BIN" "$OUT"

echo "== Страница Mantis"
npm run build --silent
node agent/pack.mjs dist agent/build/assets.bin

echo "== Встроенный Агент"
ff="$CACHE/ffmpeg-win32-x64"
if [ ! -s "$ff" ]; then
  curl -fsSL "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffmpeg-win32-x64.gz" | gunzip > "$ff"
fi
cp "$ff" agent/build/ffmpeg.bin
# без окна консоли: Агент работает внутри приложения
"$BUN" build agent/agent.ts --compile --minify --target=bun-windows-x64 --windows-hide-console \
  --loader .bin:file --outfile "$BIN/mantis-agent-$TRIPLE.exe" >/dev/null
rm -f agent/build/ffmpeg.bin
ls -lh "$BIN/mantis-agent-$TRIPLE.exe"

echo "== Приложение и установщик"
cd desktop/windows
npm ci --silent
npx tauri build --target "$TRIPLE" --bundles nsis --config "{\"version\":\"$VERSION\"}"
cd ../..

cp "$(ls desktop/windows/src-tauri/target/$TRIPLE/release/bundle/nsis/*-setup.exe | head -1)" "$OUT/Mantis-Setup.exe"
ls -lh "$OUT"
