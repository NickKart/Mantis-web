#!/usr/bin/env bash
# Первичная настройка сервера под прод Mantis (Ubuntu, nginx и Node уже стоят – сервер rcmit.ru на 1Gb).
# Запускать от root один раз (повторный запуск безопасен – уже сделанное пропускается):
#
#   curl -fsSL https://raw.githubusercontent.com/NickKart/mantis-web/main/deploy/setup-server.sh | bash -s -- mantis.rcmit.ru you@example.com
#
# Что делает:
#   1. Подкачка 2 ГБ, если её нет (чтобы нехватка памяти не уронила сайт и приложение).
#   2. PostgreSQL: пользователь и база mantis, вход только с этого сервера.
#   3. Системный пользователь mantis, папки /var/www/mantis (релизы) и /etc/mantis (настройки).
#   4. Службы systemd: API (mantis-api), ежедневное продление подписок, ночной бэкап базы.
#   5. nginx: сайт mantis.rcmit.ru рядом с rcmit.ru (rcmit.conf не трогаем), сертификат Let's Encrypt.
#   6. Права для автодеплоя из GitHub: SSH-ключ пользователя mantis и перезапуск mantis-api без пароля.

set -euo pipefail

DOMAIN="${1:-mantis.rcmit.ru}"
EMAIL="${2:-}"
APP=mantis
ROOT=/var/www/$APP
ETC=/etc/$APP
API_PORT=3100

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mxx %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "Запустите от root"
command -v nginx >/dev/null || die "Нет nginx"
command -v node >/dev/null || die "Нет Node.js"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Нужен Node.js 20 или новее, сейчас $(node -v)"
NODE_BIN=$(command -v node)

# ---------------------------------------------------------------- 1. подкачка
say "Подкачка"
if [ "$(swapon --show --noheadings | wc -l)" = 0 ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-swappiness.conf
  echo "Добавлено 2 ГБ"
else
  echo "Уже есть"
fi

# ---------------------------------------------------------------- 2. пакеты и PostgreSQL
say "Пакеты: PostgreSQL, certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql certbot >/dev/null
systemctl enable --now postgresql >/dev/null

say "Пользователь $APP"
if ! id "$APP" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$ROOT" --shell /bin/bash "$APP"
fi
install -d -o "$APP" -g "$APP" -m 755 "$ROOT" "$ROOT/releases"
install -d -o "$APP" -g "$APP" -m 700 "$ROOT/.ssh"
touch "$ROOT/.ssh/authorized_keys"
chown "$APP:$APP" "$ROOT/.ssh/authorized_keys"
chmod 600 "$ROOT/.ssh/authorized_keys"

say "База $APP"
# вход по сокету без пароля: пользователь ОС mantis = роль mantis (peer)
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname = '$APP'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE $APP LOGIN"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname = '$APP'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE DATABASE $APP OWNER $APP ENCODING 'UTF8' TEMPLATE template0"
echo "Готово (снаружи база недоступна: PostgreSQL слушает только localhost)"

# ---------------------------------------------------------------- 3. настройки
say "Настройки $ETC/$APP.env"
install -d -o root -g "$APP" -m 750 "$ETC"
if [ ! -f "$ETC/$APP.env" ]; then
  cat > "$ETC/$APP.env" <<EOF
# Настройки сервера API Mantis. После изменения: systemctl restart mantis-api
HOST=127.0.0.1
PORT=$API_PORT
NODE_ENV=production

# База оплат (PostgreSQL на этом сервере, вход по сокету)
DATABASE_URL=postgresql://$APP@/$APP?host=/var/run/postgresql

# Адрес приложения – сюда ЮKassa возвращает после оплаты
APP_URL=https://$DOMAIN

# Проверка входа пользователей (Firebase Auth)
FIREBASE_PROJECT_ID=jinpix-ac93d

# ЮKassa: личный кабинет → Интеграция → Ключи API
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=
# 1 – автоплатежи с карты (в боевом магазине – только после подключения менеджером ЮKassa)
YOOKASSA_AUTOPAY=
# Код НДС для чеков 54-ФЗ (например 1 – без НДС); пусто – без чеков
YOOKASSA_VAT_CODE=
EOF
  chown root:"$APP" "$ETC/$APP.env"
  chmod 640 "$ETC/$APP.env"
  warn "Впишите ключи ЮKassa в $ETC/$APP.env"
else
  echo "Уже есть, не трогаем"
fi

# ---------------------------------------------------------------- 4. systemd
say "Службы systemd"
cat > /etc/systemd/system/mantis-api.service <<EOF
[Unit]
Description=Mantis API (оплаты, вебхук ЮKassa)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=$APP
Group=$APP
WorkingDirectory=$ROOT/current
EnvironmentFile=$ETC/$APP.env
ExecStart=$NODE_BIN $ROOT/current/server.cjs
Restart=always
RestartSec=3
MemoryMax=512M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/mantis-charge.service <<EOF
[Unit]
Description=Mantis: ежедневное продление подписок
After=network-online.target postgresql.service

[Service]
Type=oneshot
User=$APP
Group=$APP
WorkingDirectory=$ROOT/current
EnvironmentFile=$ETC/$APP.env
ExecStart=$NODE_BIN $ROOT/current/server.cjs charge
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
EOF

cat > /etc/systemd/system/mantis-charge.timer <<EOF
[Unit]
Description=Mantis: продление подписок каждый день в 06:00 МСК

[Timer]
OnCalendar=*-*-* 06:00:00 Europe/Moscow
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

install -d -o postgres -g postgres -m 700 /var/backups/$APP /etc/mantis-backup
cat > /usr/local/bin/mantis-backup <<'EOF'
#!/usr/bin/env bash
# Ночной бэкап базы mantis: /var/backups/mantis, хранится 14 дней.
# Копия вне сервера: настройте rclone (sudo -u postgres rclone config --config /etc/mantis-backup/rclone.conf)
# и впишите хранилище в /etc/mantis-backup/backup.env:
#   RCLONE_REMOTE=yandex:mantis-backups      (хранилище в России – требование 152-ФЗ)
set -euo pipefail
DIR=/var/backups/mantis
FILE="$DIR/mantis-$(date +%F-%H%M).dump"
pg_dump -Fc mantis > "$FILE"
find "$DIR" -name 'mantis-*.dump' -mtime +14 -delete
if [ -f /etc/mantis-backup/backup.env ]; then . /etc/mantis-backup/backup.env; fi
if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$FILE" "$RCLONE_REMOTE" --config /etc/mantis-backup/rclone.conf
fi
echo "Бэкап: $FILE ($(du -h "$FILE" | cut -f1))"
EOF
chmod 755 /usr/local/bin/mantis-backup

cat > /etc/systemd/system/mantis-backup.service <<'EOF'
[Unit]
Description=Mantis: бэкап базы
After=postgresql.service

[Service]
Type=oneshot
User=postgres
ExecStart=/usr/local/bin/mantis-backup
EOF

cat > /etc/systemd/system/mantis-backup.timer <<'EOF'
[Unit]
Description=Mantis: бэкап базы каждую ночь в 03:30 МСК

[Timer]
OnCalendar=*-*-* 03:30:00 Europe/Moscow
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now mantis-charge.timer mantis-backup.timer >/dev/null
# API включается сейчас, а запускается первым деплоем (пока нет $ROOT/current)
systemctl enable mantis-api >/dev/null
echo "mantis-api, mantis-charge.timer, mantis-backup.timer"

say "Права для автодеплоя"
SYSTEMCTL=$(command -v systemctl)
cat > /etc/sudoers.d/mantis-deploy <<EOF
# Автодеплой из GitHub (пользователь mantis): только перезапуск API
$APP ALL=(root) NOPASSWD: $SYSTEMCTL restart mantis-api, $SYSTEMCTL is-active mantis-api
EOF
chmod 440 /etc/sudoers.d/mantis-deploy
visudo -cf /etc/sudoers.d/mantis-deploy >/dev/null

# ---------------------------------------------------------------- 5. nginx и сертификат
say "nginx: $DOMAIN"
SERVER_IP=$(curl -4fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ "$DNS_IP" != "$SERVER_IP" ]; then
  warn "DNS: $DOMAIN → ${DNS_IP:-нет записи}, а сервер – $SERVER_IP."
  warn "Добавьте запись A $DOMAIN → $SERVER_IP, подождите и запустите скрипт ещё раз."
  exit 1
fi

install -d -m 755 /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
grep -q 'sites-enabled' /etc/nginx/nginx.conf || die "nginx.conf не подключает sites-enabled – подключите сайт вручную"
grep -q 'application/wasm' /etc/nginx/mime.types || warn "В /etc/nginx/mime.types нет application/wasm – добавьте строку: application/wasm wasm;"
# http2 on – с nginx 1.25.1, раньше – в listen
NGINX_VER=$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9.]*\).*|\1|p')
if printf '%s\n1.25.1\n' "$NGINX_VER" | sort -V -C; then H2_LISTEN=" http2"; H2_LINE=""; else H2_LISTEN=""; H2_LINE="    http2 on;"; fi

AVAILABLE=/etc/nginx/sites-available/$DOMAIN.conf
ENABLED=/etc/nginx/sites-enabled/$DOMAIN.conf
install -d -m 755 /var/www/letsencrypt

cat > /etc/nginx/snippets/mantis-headers.conf <<'EOF'
# Многопоточная модель в браузере (SharedArrayBuffer) работает только с этими заголовками
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
EOF

reload_nginx() {
  if nginx -t 2>/tmp/nginx-test.log; then
    systemctl reload nginx
  else
    cat /tmp/nginx-test.log
    rm -f "$ENABLED"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    die "Конфиг nginx не прошёл проверку – $DOMAIN отключён, rcmit.ru работает как раньше"
  fi
}

CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
if [ ! -f "$CERT" ]; then
  # сначала только HTTP – чтобы Let's Encrypt проверил домен
  cat > "$AVAILABLE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 503; }
}
EOF
  ln -sf "$AVAILABLE" "$ENABLED"
  reload_nginx
  [ -n "$EMAIL" ] && MAIL_ARG=(--email "$EMAIL") || MAIL_ARG=(--register-unsafely-without-email)
  certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" "${MAIL_ARG[@]}" --agree-tos -n
fi

install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

cat > "$AVAILABLE" <<EOF
# Mantis – $DOMAIN. Фронт: $ROOT/current/dist, API: 127.0.0.1:$API_PORT (mantis-api).
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl$H2_LISTEN;
    listen [::]:443 ssl$H2_LISTEN;
$H2_LINE
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:MantisSSL:10m;
    ssl_session_timeout 1d;

    root $ROOT/current/dist;
    index index.html;
    client_max_body_size 1m;

    gzip on;
    gzip_types text/css application/javascript application/json application/wasm image/svg+xml;
    gzip_min_length 1024;

    include snippets/mantis-headers.conf;

    location /api/ {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # файлы сборки с хешем в имени – кэш на год
    location /assets/ {
        include snippets/mantis-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }

    # модель нейросети – кэш на неделю
    location /models/ {
        include snippets/mantis-headers.conf;
        add_header Cache-Control "public, max-age=604800" always;
        try_files \$uri =404;
    }

    location ~* \.html$ {
        include snippets/mantis-headers.conf;
        add_header Cache-Control "no-cache" always;
        try_files \$uri =404;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF
ln -sf "$AVAILABLE" "$ENABLED"
reload_nginx
echo "https://$DOMAIN"

# ---------------------------------------------------------------- итог
say "Готово"
cat <<EOF
Дальше:
  1. Ключи ЮKassa:          nano $ETC/$APP.env
  2. Ключ автодеплоя:       добавьте открытый ключ в $ROOT/.ssh/authorized_keys
     (закрытый – в GitHub: Settings → Secrets → Actions → PROD_SSH_KEY)
  3. Отпечаток сервера:     ssh-keyscan -t ed25519 $SERVER_IP   → секрет PROD_SSH_KNOWN_HOSTS
  4. Первый деплой:         пуш в ветку prod или Actions → «Деплой в прод» → Run workflow
  5. Уведомления ЮKassa:    https://$DOMAIN/api/yookassa/webhook
EOF
