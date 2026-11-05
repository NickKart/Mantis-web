// Числа и даты по-русски: «12 480», «23%», «+2,9 п.п.», «≈ 369 000 ₽».

const NB = " ";

export const num = (v: number): string => Math.round(v).toLocaleString("ru-RU").replace(/\s/g, NB);

/** Доля в процентах: до 10% – с одним знаком после запятой. */
export function pct(part: number, whole: number, digits?: number): string {
  if (!(whole > 0)) return "–";
  const v = (part / whole) * 100;
  const d = digits ?? (v < 10 && v > 0 ? 1 : 0);
  return `${v.toFixed(d).replace(".", ",")}%`;
}

export const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/** Изменение в процентах: «+4%», «−3%». */
export function deltaPct(cur: number, prev: number): { text: string; tone: "up" | "down" | "flat" } | null {
  if (!(prev > 0)) return null;
  const d = ((cur - prev) / prev) * 100;
  const r = Math.round(d);
  return { text: `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`, tone: Math.abs(d) < 1 ? "flat" : d > 0 ? "up" : "down" };
}

/** Разница долей в процентных пунктах: «+2,9 п.п.». */
export function deltaPp(cur: number, prev: number): { text: string; tone: "up" | "down" | "flat" } {
  const d = (cur - prev) * 100;
  return { text: `${d > 0.05 ? "+" : d < -0.05 ? "−" : ""}${Math.abs(d).toFixed(1).replace(".", ",")}${NB}п.п.`, tone: Math.abs(d) < 0.5 ? "flat" : d > 0 ? "up" : "down" };
}

export const rub = (v: number): string => `${num(Math.round(v / 1000) * 1000)}${NB}₽`;

export const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export const hhmmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, "0")).join(":");
};

export const timeHM = (d: Date): string => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

const pad = (n: number) => String(n).padStart(2, "0");
/** Ключ дня YYYY-MM-DD в местном времени. */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseDay(k: string): Date {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const startOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

/** «28 октября», «Сегодня», «Вчера». */
export function dayLabel(d: Date, rel = true): string {
  const today = startOfDay(new Date()).getTime();
  const t = startOfDay(d).getTime();
  if (rel && t === today) return "Сегодня";
  if (rel && t === today - 86_400_000) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** «14–20 октября», «28 октября – 3 ноября». */
export function rangeLabel(from: Date, to: Date): string {
  if (startOfDay(from).getTime() === startOfDay(to).getTime()) return dayLabel(from, false);
  if (from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear())
    return `${from.getDate()}–${to.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`;
  return `${dayLabel(from, false)} – ${dayLabel(to, false)}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few;
  return many;
}

export const WEEKDAYS_FULL = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
export const WEEKDAYS_ACC = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
