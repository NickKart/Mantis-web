// События A/B-теста веб-версии – общий список для обеих версий (ab/client.ts) и сервера (server/ab.ts).
import config from "./config.json";

export const AB_CONFIG = config as {
  experiment: string;
  active: boolean;
  splitB: number;
  force: "a" | "b" | null;
  winner: "a" | "b" | null;
  hosts: string[];
  activationDays: number;
};

export const AB_EVENTS = [
  "session_start", // приложение открыто
  "signup", // зарегистрировался в этом браузере
  "login", // вошёл (в том числе аккаунт из приложения на iPhone)
  "screen_view", // открыл экран {screen}
  "camera_added", // добавил камеру или источник видео
  "counting_started", // запустил подсчёт
  "hours_saved", // почасовая статистика ушла в облако {passed} – признак, что подсчёт реально шёл
  "recording_saved", // сохранил запись
  "report_exported", // выгрузил отчёт
  "subscription_open", // открыл подписку
  "payment_start", // перешёл к оплате или привязке карты {kind}
  "desktop_offer", // в веб-версии открыл подключение IP-камеры – показано предложение скачать программу {os}
  "desktop_download", // нажал «Скачать» программу Mantis для компьютера {os}
  "error", // заметная ошибка {where}
] as const;

export type AbEvent = (typeof AB_EVENTS)[number];

export const isAbEvent = (s: unknown): s is AbEvent => typeof s === "string" && (AB_EVENTS as readonly string[]).includes(s);
