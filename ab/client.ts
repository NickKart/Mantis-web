// A/B-тест веб-версии в браузере – общий для новой (A) и старой (B) версии.
// Вариант выбирает ab/gate.js до загрузки приложения; здесь – закрепление за аккаунтом после входа и события.
// Работает только там, где идёт тест (mantis.rcmit.ru); на Vercel, в Агенте и при разработке – ничего не делает.
//
//   abInit(() => токен Firebase или null)   – один раз при запуске
//   abUser(uid)                             – при входе и выходе
//   abTrack("camera_added")                 – событие (список – ab/events.ts)

import type { AbEvent } from "./events";

interface GateState {
  experiment: string;
  variant: "a" | "b";
  running: boolean;
  test: boolean;
  vid: string | null;
  home: Record<"a" | "b", string>;
}

declare global {
  interface Window {
    __mantisAB?: GateState;
  }
}

interface Queued { name: AbEvent; data?: Record<string, unknown> }

const FLUSH_MS = 8000;
let gate: GateState | null = null;
let token: () => Promise<string | null> = async () => null;
let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let lastUid: string | null | undefined;
const lastAt = new Map<string, number>();

const on = () => !!gate?.running && !!gate.vid;

/** Вариант этой страницы: "a" – новая версия, "b" – старая. null – тест здесь не идёт. */
export function abVariant(): "a" | "b" | null {
  return gate?.running ? gate.variant : null;
}

export function abInit(getToken: () => Promise<string | null>): void {
  gate = typeof window !== "undefined" ? window.__mantisAB ?? null : null;
  if (!on()) return;
  token = getToken;
  abTrack("session_start", { path: location.pathname, ref: referrer(), utm: utm() });
  addEventListener("pagehide", () => void flush(true));
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush(true);
  });
}

/** С какого сайта пришёл посетитель (до перехода между версиями – его сохраняет ab/gate.js). */
function referrer(): string | null {
  let r = document.referrer;
  try {
    r = sessionStorage.getItem("mantis_ab_ref") ?? r;
    sessionStorage.removeItem("mantis_ab_ref");
  } catch {
    /* нет */
  }
  try {
    return r ? new URL(r).hostname : null;
  } catch {
    return null;
  }
}

/** Метки рекламы и источника в адресе первого захода (utm_source и т. п.). */
function utm(): Record<string, string> | null {
  const out: Record<string, string> = {};
  new URLSearchParams(location.search).forEach((v, k) => {
    if (/^utm_/.test(k)) out[k] = v.slice(0, 100);
  });
  return Object.keys(out).length ? out : null;
}

/** Событие. minGapMs – не чаще раза в столько миллисекунд (для частых событий вроде hours_saved). */
export function abTrack(name: AbEvent, data?: Record<string, unknown>, minGapMs = 0): void {
  if (!on()) return;
  if (minGapMs) {
    const now = Date.now();
    if (now - (lastAt.get(name) ?? 0) < minGapMs) return;
    lastAt.set(name, now);
  }
  queue.push({ name, data });
  if (queue.length >= 40) void flush();
  else timer ??= setTimeout(() => void flush(), FLUSH_MS);
}

async function headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const t = await token().catch(() => null);
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function flush(leaving = false): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length || !gate) return;
  const events = queue.splice(0, 50);
  const body = JSON.stringify({ experiment: gate.experiment, variant: gate.variant, vid: gate.vid, test: gate.test, events });
  try {
    // при уходе со страницы токен не ждём – событие уйдёт без входа и привяжется к аккаунту по браузеру
    const h = leaving ? { "Content-Type": "application/json" } : await headers();
    const r = await fetch("/api/ab/event", { method: "POST", headers: h, body, keepalive: true });
    if (r.status >= 500 && !leaving) queue.unshift(...events);
  } catch {
    if (!leaving) queue.unshift(...events.slice(-20));
  }
  if (queue.length && !leaving) timer = setTimeout(() => void flush(), FLUSH_MS * 2);
}

/** Пользователь вошёл (uid) или вышел (null). При входе вариант закрепляется за аккаунтом; если у аккаунта другой – переходим. */
export async function abUser(uid: string | null): Promise<void> {
  if (!on() || uid === lastUid) return;
  lastUid = uid;
  if (!uid || !gate) return;
  try {
    const r = await fetch("/api/ab/assign", {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify({ experiment: gate.experiment, variant: gate.variant, vid: gate.vid, test: gate.test }),
    });
    if (!r.ok) return;
    const a = (await r.json()) as { variant?: "a" | "b"; running?: boolean };
    abTrack("login");
    if (a.running && (a.variant === "a" || a.variant === "b") && a.variant !== gate.variant && !gate.test) {
      await flush();
      document.cookie = `mantis_v=${a.variant}; path=/; max-age=${365 * 24 * 3600}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
      location.replace(gate.home[a.variant] + location.search + location.hash);
    }
  } catch {
    // нет связи – вариант закрепится при следующем входе
  }
}
