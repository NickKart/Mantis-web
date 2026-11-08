#!/usr/bin/env bash
# Выкладка релиза на сервере (запускает GitHub Actions от пользователя mantis):
#   bash remote-deploy.sh /tmp/mantis-<sha>.tar.gz <sha>
# Распаковывает в /var/www/mantis/releases/<sha>, обновляет схему базы, переключает current,
# перезапускает API и проверяет его. Если API не поднялся – возвращает предыдущий релиз.
# В конце забирает из релиза новые архивы Mantis Агента в shared/downloads (dist/downloads – ссылка туда).

set -euo pipefail

ARCHIVE="$1"
SHA="$2"
ROOT=/var/www/mantis
REL="$ROOT/releases/$SHA"
KEEP=5
SYSTEMCTL=$(command -v systemctl)

health() {
  for _ in $(seq 1 15); do
    curl -fsS --max-time 2 http://127.0.0.1:3100/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

rm -rf "$REL"
mkdir -p "$REL"
tar -xzf "$ARCHIVE" -C "$REL"
rm -f "$ARCHIVE"
[ -f "$REL/dist/index.html" ] && [ -f "$REL/server.cjs" ] || { echo "В архиве нет dist/index.html или server.cjs"; exit 1; }
[ -f "$REL/dist/b/index.html" ] || echo "Внимание: в архиве нет старой версии (dist/b) – вариант B A/B-теста не откроется"
# архивы Агента лежат вне релизов (их ~300 МБ), сайт отдаёт их по /downloads/
DL="$ROOT/shared/downloads"
mkdir -p "$DL"
ln -sfn "$DL" "$REL/dist/downloads"

echo "== Схема базы"
if ! psql -q -v ON_ERROR_STOP=1 -d mantis -f "$REL/schema.sql" >/tmp/mantis-schema.log 2>&1; then
  cat /tmp/mantis-schema.log
  echo "Схема базы не применилась – релиз не переключён"
  exit 1
fi

PREV=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -sfn "$REL" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"

echo "== Перезапуск API"
sudo -n "$SYSTEMCTL" restart mantis-api
if ! health; then
  echo "API не отвечает после деплоя"
  if [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$REL" ]; then
    echo "== Откат на $(basename "$PREV")"
    ln -sfn "$PREV" "$ROOT/current.new"
    mv -Tf "$ROOT/current.new" "$ROOT/current"
    sudo -n "$SYSTEMCTL" restart mantis-api
    health && echo "Откат выполнен, API работает"
  fi
  exit 1
fi

echo "== Старые релизы (оставляем $KEEP)"
cd "$ROOT/releases"
ls -1t | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$ROOT/releases/$old" = "$(readlink -f "$ROOT/current")" ] || rm -rf -- "$old"
done

echo "== Mantis Агент"
# Скачиваем только изменившиеся архивы, с проверкой sha256. Неудача не ломает выкладку – останутся прежние.
BASE="${MANTIS_RELEASE_URL:-https://github.com/NickKart/mantis-web/releases/latest/download}"
if [ -f "$REL/agent.sha256" ]; then
  while read -r sum name; do
    case "$name" in Mantis-Agent-*.zip) ;; *) continue ;; esac
    if [ -f "$DL/$name" ] && echo "$sum  $DL/$name" | sha256sum -c --quiet >/dev/null 2>&1; then
      echo "   $name – без изменений"
      continue
    fi
    if curl -fsSL --retry 2 --max-time 240 -o "$DL/.$name.part" "$BASE/$name" \
      && echo "$sum  $DL/.$name.part" | sha256sum -c --quiet >/dev/null 2>&1; then
      mv -f "$DL/.$name.part" "$DL/$name"
      echo "   $name – обновлён"
    else
      rm -f "$DL/.$name.part"
      echo "   (!) $name не скачался – остаётся прежний"
    fi
  done < "$REL/agent.sha256"
else
  echo "   в релизе нет Агента – оставляем прежние архивы"
fi

echo "Готово: $SHA"
