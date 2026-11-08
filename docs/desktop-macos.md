# Mantis для macOS

Настольное приложение: своё окно, значок в Dock и меню. Браузер не нужен. Внутри та же страница Mantis, что на https://mantis.rcmit.ru (вариант A), и встроенный Агент – мост IP-камер и ffmpeg.

## Как устроено
- `desktop/macos/src-tauri` – приложение на Tauri 2 (Rust). Окно – системный движок macOS (WKWebView).
- При запуске приложение стартует встроенный Агент (`agent/agent.ts`, собран Bun-ом) с `MANTIS_SHELL=macos` на порту 8797. Агент печатает `MANTIS_READY port=N`, приложение открывает `http://127.0.0.1:N/?desktop=macos`.
- Агент отдаёт страницу с COOP/COEP (многопоточная нейросеть) и подключает IP-камеры. Закрывается вместе с приложением.
- Команды оболочки для страницы (`src/desktop.ts`): `app_info`, `keep_awake` (caffeinate), `set_autostart` (LaunchAgent), `quit_app`, `pilot_state`. Разрешены только для 127.0.0.1 (`capabilities/default.json`).
- Пока идёт подсчёт, закрытие окна прячет его. Вернуть окно – клик по значку в Dock. Фоновое замедление WKWebView и App Nap отключены.
- Ссылки на другие сайты и оплата ЮKassa открываются в браузере по умолчанию.
- Меню «Mantis»: «Главная Mantis» (⇧⌘H), «Обновить страницу» (⌘R), «Проверка компьютера» (⇧⌘D) – страница `desktop-check.html`.

## Сборка
- GitHub Actions: пуш в ветку `desktop-macos` или Actions → «Mantis для macOS» → Run workflow. Результат – предварительный релиз (prerelease) с `Mantis-macOS-arm64.dmg` и `Mantis-macOS-x64.dmg`. Prerelease не становится «latest», поэтому прод-сервер его не забирает.
- Локально на Mac: `bash desktop/macos/build.sh arm64` (или `x64`) → `desktop/macos/out/`.

## Подпись
Сейчас ad-hoc: при первом запуске macOS спросит, открывать ли приложение от неизвестного разработчика – «Системные настройки» → «Конфиденциальность и безопасность» → «Всё равно открыть». Для установки без предупреждений нужен сертификат Developer ID и заверение у Apple: переменные `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` в секретах GitHub, Tauri подпишет и заверит сам.

## Проверка компьютера
`desktop-check.html` – одна страница для приложения и для Chrome на том же Mac: многопоточность, WebGPU, скорость нейросети на видеокарте и процессоре, камера, работа в свёрнутом окне. Кнопка «Скопировать результаты» – для сравнения.
