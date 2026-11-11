# Mantis Агент: сборка и раздача

Mantis Агент – программа для компьютера у витрины, нужна для IP-камер. Внутри у неё веб-страница Mantis (новая версия), мост IP-камер (поиск ONVIF, RTSP → кадры) и ffmpeg. Агент открывает страницу на http://localhost:8787. Исходники – `agent/`, мост – `bridge/`, инструкция для пользователя – `agent/README-agent.txt`.

## Скачать

| Платформа | Ссылка |
|---|---|
| Windows – Mantis Агент | https://mantis.rcmit.ru/downloads/Mantis-Agent-Windows.zip |
| Mac – приложение Mantis (все Mac, macOS 13+) | https://mantis.rcmit.ru/downloads/Mantis-Installer.pkg |
| Mac – Агент, Apple Silicon (кнопок на него нет) | https://mantis.rcmit.ru/downloads/Mantis-Agent-macOS-arm64.zip |
| Mac – Агент, Intel (кнопок на него нет) | https://mantis.rcmit.ru/downloads/Mantis-Agent-macOS-x64.zip |

IP-камеры работают только в программе для компьютера (приложение Mantis для Mac, Агент для Windows): в веб-версии моста нет. На шаге «Источник» → «IP-камера» (версия A) и в окне «IP-камера» (версия B) веб-версия вместо формы предлагает скачать программу и войти в ней тем же логином и паролем (`src/downloads.ts`). Кнопки ведут: «Скачать для Windows» – на Агент, «Скачать для macOS» – на установщик приложения Mantis для Mac (окно + этот же Агент внутри, docs/desktop-macos.md). Архивы Агента для Mac пока собираются для тех, у кого уже есть ссылка.

## Как попадает на сервер

1. «Деплой в прод» (`.github/workflows/deploy-prod.yml`) в отдельной задаче `agent` на macOS-машине собирает три архива: `bash agent/build.sh darwin-arm64 darwin-x64 windows-x64`. Приложение для Mac подписывается ad-hoc через codesign. В Агент попадает текущая сборка страницы, кроме старой версии для A/B-теста (`b/`) и `ab.html`.
2. Архивы и их sha256 прикладываются к тому же GitHub Release, что и сайт. В архив сайта кладётся `agent.sha256`.
3. Там же отдельная задача `mac-app` собирает приложение Mantis для Mac (`bash desktop/macos/build.sh universal`), проверяет подпись (обе архитектуры, разрешение на камеру) и установку из `Mantis-Installer.pkg`. Установщик и его sha256 идут в тот же релиз.
4. На сервере `remote-deploy.sh` после выкладки сайта скачивает изменившиеся архивы и установщик в `/var/www/mantis/shared/downloads` и сверяет sha256. `dist/downloads` в каждом релизе – ссылка на эту папку.
5. Если Агент или приложение не собрались или не скачались, сайт всё равно выкладывается, а на сервере остаются прежние архивы.

Архивы весят около 100 МБ каждый (Bun, ffmpeg и страница с нейросетью), поэтому в релизы сайта они не входят.

## Вручную

```
npm ci
bash agent/build.sh                 # все платформы → agent/dist/Mantis-Agent-*.zip
bash agent/build.sh linux-x64       # для проверки на Linux: agent/dist/mantis-agent-linux-x64 --no-browser
```

Нужны Node, Bun ≥ 1.4 (`BUN=путь`), а для подписи Mac-приложения – codesign на Mac или rcodesign.

## Подпись Apple

Сейчас приложение для Mac не подписано сертификатом Apple. При первом запуске macOS его остановит, и пользователь разрешает запуск в «Системные настройки» → «Конфиденциальность и безопасность» → «Всё равно открыть». С сертификатом Developer ID (`MAC_SIGN_ID`) и заверением у Apple это предупреждение пропадёт – см. план приложения для macOS.
