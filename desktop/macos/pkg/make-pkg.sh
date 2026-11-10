#!/usr/bin/env bash
# Установщик Mantis для macOS (.pkg): двойной клик → мастер «Продолжить → Установить» →
# Mantis в папке «Программы» и запущен. Прежняя версия заменяется.
#   bash desktop/macos/pkg/make-pkg.sh <путь к Mantis.app> <версия> <выходной .pkg>
# Подпись установщика: если задан APPLE_INSTALLER_IDENTITY («Developer ID Installer: …»), pkg подписывается.
set -euo pipefail

APP="$1"
VERSION="$2"
OUT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/root" "$WORK/parts" "$WORK/scripts"
ditto "$APP" "$WORK/root/Mantis.app"
cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$WORK/scripts/"
chmod 755 "$WORK/scripts/"*

# Ставить строго в /Applications: без этого Installer «находит» копию приложения в другом месте
# (например, в загрузках) и обновляет её там.
pkgbuild --analyze --root "$WORK/root" "$WORK/component.plist" >/dev/null
plutil -replace 0.BundleIsRelocatable -bool NO "$WORK/component.plist"

pkgbuild --root "$WORK/root" --component-plist "$WORK/component.plist" \
  --install-location /Applications --scripts "$WORK/scripts" \
  --identifier ru.rcmit.mantis --version "$VERSION" \
  "$WORK/parts/mantis-app.pkg" >/dev/null

sed "s/@VERSION@/$VERSION/" "$HERE/distribution.xml" > "$WORK/distribution.xml"

sign=()
if [ -n "${APPLE_INSTALLER_IDENTITY:-}" ]; then
  sign=(--sign "$APPLE_INSTALLER_IDENTITY")
fi
mkdir -p "$(dirname "$OUT")"
productbuild --distribution "$WORK/distribution.xml" --resources "$HERE/resources" \
  --package-path "$WORK/parts" ${sign[@]+"${sign[@]}"} "$OUT" >/dev/null
ls -lh "$OUT"
