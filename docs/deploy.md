# Прод: mantis.rcmit.ru

## Контуры

| Контур | Где | Ветка | База оплат |
|---|---|---|---|
| Разработка | Vercel, https://mantis-web-snowy.vercel.app | `main` (и превью веток) | Firestore (`api/_lib/store.ts`) |
| Прод | VDS на 1Gb (тот же сервер, что rcmit.ru, 81.177.166.58), https://mantis.rcmit.ru | `prod` | PostgreSQL на сервере (`api/_lib/store-pg.ts`) |

Выкатить в прод: влить изменения в `prod` (`git push origin main:prod`) или Actions → «Деплой в прод» → Run workflow.

Как идёт релиз: GitHub Actions прогоняет тесты, собирает фронт и сервер API и публикует архив как GitHub Release (latest) с контрольной суммой. Сервер раз в минуту сам проверяет последний релиз (`mantis-update.timer`), скачивает, сверяет sha256 и выкладывает. Ключи и секреты не нужны: репозиторий публичный, сервер ничего не принимает извне. Workflow ждёт, пока `/api/health` покажет новый коммит, и проверяет заголовки.

## Как устроено на сервере

- **nginx** раздаёт фронт из `/var/www/mantis/current/dist` с заголовками COOP/COEP (без них браузер выключает многопоточность у модели) и проксирует `/api/*` на `127.0.0.1:3100`. Конфиг – `/etc/nginx/sites-available/mantis.rcmit.ru.conf`, общие заголовки – `/etc/nginx/snippets/mantis-headers.conf`. Конфиг rcmit.ru (`rcmit.conf`) не трогаем.
- **mantis-api** (systemd) – сервер API `server/index.ts`: те же обработчики `api/*`, что на Vercel, собранные в один файл `server.cjs` (`npm run build:server`, node_modules на сервере не нужны). Настройки – `/etc/mantis/mantis.env`.
- **mantis-charge.timer** – продление подписок каждый день в 06:00 МСК (`node server.cjs charge`). Вместо Vercel Cron; наружу `/api/cron/charge` не открыт.
- **mantis-backup.timer** – `pg_dump` каждую ночь в 03:30 МСК в `/var/backups/mantis`, хранится 14 дней. Копию вне сервера настройте через rclone в российское хранилище (Yandex Object Storage, Selectel) – см. комментарий в `/usr/local/bin/mantis-backup`.
- **PostgreSQL** – база и роль `mantis`, вход по сокету без пароля (пользователь ОС `mantis`), снаружи недоступна. Схема – `server/schema.sql`, применяется при каждом деплое.
- **mantis-update.timer** – раз в минуту `/usr/local/bin/mantis-update`: новый релиз на GitHub → скачать, сверить sha256, выложить (`remote-deploy.sh` из архива). Неудачный релиз помечается в `/var/www/mantis/state` и больше не пробуется – выпустите исправленный.
- **Релизы** – `/var/www/mantis/releases/<sha>`, `current` – ссылка на текущий. Хранятся последние 5. Если после деплоя API не ответил на `/api/health`, скрипт возвращает предыдущий релиз.
- **Let's Encrypt** – certbot продлевает сертификат сам и перезагружает nginx.

## Первый запуск

1. **DNS.** В зоне rcmit.ru: запись `A mantis → 81.177.166.58`. Проверка: `dig +short mantis.rcmit.ru`.
2. **Настройка сервера** (от root, один раз; повторный запуск безопасен):
   ```bash
   ssh root@81.177.166.58
   curl -fsSL https://raw.githubusercontent.com/NickKart/mantis-web/main/deploy/setup-server.sh | bash -s -- mantis.rcmit.ru почта@для-letsencrypt
   ```
3. **Ключи ЮKassa** – в `/etc/mantis/mantis.env` (`YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, при необходимости `YOOKASSA_AUTOPAY`, `YOOKASSA_VAT_CODE`). Для прода – боевой магазин, для Vercel – тестовый.
4. **Первый деплой:** `git push origin main:prod` – сервер выложит релиз в течение минуты.
5. **ЮKassa** (боевой магазин) → Интеграция → HTTP-уведомления → `https://mantis.rcmit.ru/api/yookassa/webhook`, события `payment.succeeded`, `payment.canceled`, `payment_method.active`.
6. **Firebase** → Authentication → Settings → Authorized domains → добавить `mantis.rcmit.ru`. Если у ключа API в Google Cloud стоят ограничения по сайтам – добавить и его.

## Обслуживание

```bash
systemctl status mantis-api                 # состояние API
journalctl -u mantis-api -f                 # логи API
journalctl -u mantis-charge --since today   # что списалось сегодня
systemctl start mantis-charge               # продлить подписки вручную
systemctl list-timers 'mantis-*'            # когда следующий запуск
journalctl -u mantis-update --since today   # какие релизы выкладывались
rm /var/www/mantis/state/failed-<sha>       # повторить выкладку неудачного релиза
sudo -u mantis psql mantis                  # база
systemctl start mantis-backup               # бэкап вручную
```

Откат на предыдущий релиз вручную:
```bash
cd /var/www/mantis && ls -1t releases          # выбрать релиз
sudo -u mantis ln -sfn /var/www/mantis/releases/<sha> current && systemctl restart mantis-api
```

Восстановление базы из бэкапа:
```bash
systemctl stop mantis-api
sudo -u postgres pg_restore --clean --if-exists -d mantis /var/backups/mantis/mantis-<дата>.dump
systemctl start mantis-api
```

## Персональные данные (152-ФЗ)

- Оплаты, почта для чеков, привязки карт – в PostgreSQL на сервере в России.
- Видео обрабатывается в браузере и на сервер не уходит.
- Вход пользователей (почта, пароль) и почасовая статистика пока в Firebase (Google) – они общие с iOS-приложением. Перенос входа в Россию – отдельный этап, его нужно согласовать с командой iOS.

## Проверка локально

```bash
npm run build && npm run build:server
DATABASE_URL=postgresql://localhost/mantis node server/dist/server.cjs   # API на 127.0.0.1:3100
TEST_DATABASE_URL=postgresql://localhost/mantis_test npm test            # тесты оплат на PostgreSQL (база очищается!)
```
