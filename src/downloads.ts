// Программа Mantis для компьютера. IP-камеры работают только в ней: в веб-версии (браузер) моста к камерам нет.
// Файлы собирает «Деплой в прод» и кладёт на прод-сервер в downloads/ (docs/agent.md).
// Общий модуль для версий A (src/) и B (legacy/). Адреса полные: работают и на Vercel.

const DL = "https://mantis.rcmit.ru/downloads";

export const DESKTOP_LINKS = {
  /** Windows – приложение Mantis, установщик (Windows 10 и 11, 64-бит). */
  windows: `${DL}/Mantis-Setup.exe`,
  /** macOS – приложение Mantis, установщик для всех Mac (Apple Silicon и Intel). */
  mac: `${DL}/Mantis-Installer.pkg`,
} as const;

export type DesktopOs = keyof typeof DESKTOP_LINKS;

/** ОС посетителя – её кнопку показываем главной. null – телефон или другая система. */
export function guessDesktopOs(): DesktopOs | null {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone|iPad|Android/i.test(ua)) return null;
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  return null;
}

export const DESKTOP_TEXT = {
  title: "IP-камеры работают в программе Mantis для компьютера",
  lead:
    "В веб-версии IP-камеры не подключаются: браузер не умеет искать камеры в сети и принимать их видео. " +
    "Скачайте Mantis для компьютера и установите его на компьютер у витрины, в той же сети, что и камеры.",
  login:
    "Войдите в программе с тем же логином и паролем, что и здесь: подписка и статистика у аккаунта общие.",
  mac:
    "macOS 13 и новее, Mac на M1 и новее или на Intel. Откройте Mantis-Installer.pkg и нажмите «Установить». " +
    "Если Mac не даёт открыть установщик – «Системные настройки» → «Конфиденциальность и безопасность» → «Всё равно открыть».",
  windows:
    "Windows 10 и 11 (64-бит). Откройте Mantis-Setup.exe и нажмите «Установить». " +
    "Если Windows покажет «Система Windows защитила ваш компьютер» – нажмите «Подробнее» → «Выполнить в любом случае».",
  webcam: "Камеру компьютера или USB-камеру можно подключить и здесь, в браузере.",
};
