// Аналитика за период: воронка, изменение к прошлому периоду, часы и дни недели, автовыводы, оформления витрины.
// Считается из почасовой статистики (users/{uid}/hours – та же, что у iOS).

import type { BusinessProfile } from "../cloud/firebase";
import { type HourStat, addHours, emptyHour, keyDate } from "../pilot/hours";
import type { Showcase } from "./core";
import { WEEKDAYS_ACC, addDays, dayKey, dayLabel, num, parseDay, pct, plural, rangeLabel, ratio, startOfDay } from "./format";

export interface Period {
  /** Начало (00:00 первого дня). */
  from: Date;
  /** Конец, не включительно (00:00 дня после последнего). */
  to: Date;
  kind: "today" | "7" | "30" | "custom";
}

export function periodOf(kind: Period["kind"], custom?: { from: string; to: string }, now = new Date()): Period {
  const today = startOfDay(now);
  if (kind === "today") return { from: today, to: addDays(today, 1), kind };
  if (kind === "custom" && custom) {
    const a = parseDay(custom.from), b = parseDay(custom.to);
    const [f, t] = a <= b ? [a, b] : [b, a];
    return { from: f, to: addDays(t, 1), kind };
  }
  const n = kind === "30" ? 30 : 7;
  return { from: addDays(today, -(n - 1)), to: addDays(today, 1), kind };
}

export const periodDays = (p: Period): number => Math.round((p.to.getTime() - p.from.getTime()) / 86_400_000);

/** Такой же по длине период прямо перед этим. */
export function previousPeriod(p: Period): Period {
  const d = periodDays(p);
  return { from: addDays(p.from, -d), to: p.from, kind: p.kind };
}

/** Ключ периода для чеков: «с|по» (последний день включительно). */
export const periodKey = (p: Period): string => `${dayKey(p.from)}|${dayKey(addDays(p.to, -1))}`;

export function periodTitle(p: Period): string {
  if (p.kind === "today") return "сегодня";
  if (p.kind === "7") return "7 дней";
  if (p.kind === "30") return "30 дней";
  return rangeLabel(p.from, addDays(p.to, -1));
}

/** «к прошлым 7 дням», «ко вчера», «к прошлому периоду». */
export function prevTitle(p: Period): string {
  if (p.kind === "today") return "ко вчера";
  if (p.kind === "7") return "к прошлым 7 дням";
  if (p.kind === "30") return "к прошлым 30 дням";
  return "к такому же периоду раньше";
}

export interface Row {
  date: Date;
  stat: HourStat;
}

export function rowsIn(hours: Record<string, HourStat>, from: Date, to: Date): Row[] {
  const out: Row[] = [];
  for (const [k, v] of Object.entries(hours)) {
    const d = keyDate(k);
    if (d && d >= from && d < to) out.push({ date: d, stat: v });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export const sum = (rows: Row[]): HourStat => rows.reduce((a, r) => addHours(a, r.stat), emptyHour());

const dayStartMs = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export const daysObserved = (rows: Row[]): number => new Set(rows.filter((r) => r.stat.seconds > 0 || r.stat.people > 0).map((r) => dayStartMs(r.date))).size;

// ---------------------------------------------------------------- воронка
export interface FunnelStep {
  key: "people" | "slowed" | "looked" | "entered";
  label: string;
  value: number;
  /** Ширина полоски – доля от прошедших. */
  width: number;
  rate: string;
  delta: { text: string; tone: "up" | "down" | "flat" } | null;
}

/** Скорость в час наблюдения: честное сравнение периодов с разным временем работы камеры. */
const perHour = (v: number, sec: number) => (sec > 0 ? (v / sec) * 3600 : v);

export function deltaOf(cur: number, curSec: number, prev: number, prevSec: number): FunnelStep["delta"] {
  const useRate = curSec > 0 && prevSec > 0;
  const a = useRate ? perHour(cur, curSec) : cur, b = useRate ? perHour(prev, prevSec) : prev;
  if (!(b > 0)) return null;
  const d = ((a - b) / b) * 100;
  const r = Math.round(d);
  return { text: `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`, tone: Math.abs(d) < 1 ? "flat" : d > 0 ? "up" : "down" };
}

export function funnel(t: HourStat, prev: HourStat | null): FunnelStep[] {
  const d = (k: keyof HourStat) => (prev ? deltaOf(t[k], t.seconds, prev[k], prev.seconds) : null);
  const lookedBase = t.looked <= t.slowed && t.slowed > 0;
  return [
    { key: "people", label: "Прошли мимо", value: t.people, width: t.people > 0 ? 1 : 0, rate: "весь поток в зоне камеры", delta: d("people") },
    { key: "slowed", label: "Притормозили", value: t.slowed, width: ratio(t.slowed, t.people), rate: `${pct(t.slowed, t.people)} от прошедших`, delta: d("slowed") },
    {
      key: "looked", label: "Посмотрели", value: t.looked, width: ratio(t.looked, t.people),
      rate: lookedBase ? `${pct(t.looked, t.slowed)} от притормозивших` : `${pct(t.looked, t.people)} от прошедших`, delta: d("looked"),
    },
    {
      key: "entered", label: "Зашли", value: t.entered, width: ratio(t.entered, t.people),
      rate: `${pct(t.entered, t.people)} от прошедших · ${pct(t.entered, t.looked)} от посмотревших`, delta: d("entered"),
    },
  ];
}

// ---------------------------------------------------------------- часы и дни недели
export interface HourBar {
  hour: number;
  passed: number;
  looked: number;
}

/** Среднее за день по каждому часу (делим на число дней, когда этот час наблюдался); рабочие часы – где есть данные. */
export function hourBars(rows: Row[]): HourBar[] {
  const p = new Array(24).fill(0), l = new Array(24).fill(0), n = new Array(24).fill(0);
  for (const r of rows) {
    const h = r.date.getHours();
    p[h] += r.stat.people;
    l[h] += r.stat.looked;
    n[h] += 1;
  }
  const has = p.map((v, h) => v > 0 || n[h] > 0 && rows.some((r) => r.date.getHours() === h && r.stat.seconds > 0));
  let a = has.indexOf(true), b = has.lastIndexOf(true);
  if (a < 0) [a, b] = [9, 21];
  if (b - a < 5) {
    a = Math.max(0, Math.min(a, 9));
    b = Math.min(23, Math.max(b, a + 12));
  }
  const out: HourBar[] = [];
  for (let h = a; h <= b; h++) out.push({ hour: h, passed: n[h] ? p[h] / n[h] : 0, looked: n[h] ? l[h] / n[h] : 0 });
  return out;
}

export interface WeekdayCell {
  label: string;
  /** Доля посмотревших, 0–1; null – нет данных. */
  share: number | null;
  people: number;
  days: number;
}

export function weekdays(rows: Row[]): WeekdayCell[] {
  const L = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const ppl = new Array(7).fill(0), look = new Array(7).fill(0);
  const days = Array.from({ length: 7 }, () => new Set<number>());
  for (const r of rows) {
    const wd = (r.date.getDay() + 6) % 7;
    ppl[wd] += r.stat.people;
    look[wd] += r.stat.looked;
    if (r.stat.people > 0 || r.stat.seconds > 0) days[wd].add(dayStartMs(r.date));
  }
  return L.map((label, i) => ({ label, share: ppl[i] > 0 ? look[i] / ppl[i] : null, people: days[i].size ? ppl[i] / days[i].size : 0, days: days[i].size }));
}

// ---------------------------------------------------------------- оформления витрины
/** Оформление, действующее на день d (последнее начавшееся не позже d). */
export function showcaseAt(list: Showcase[], d: Date): Showcase | null {
  const k = dayKey(d);
  let best: Showcase | null = null;
  for (const s of list) if (s.from <= k && (!best || s.from > best.from)) best = s;
  return best;
}

/** Интервал действия оформления: [с, до) – до начала следующего или до завтра. */
export function showcaseRange(list: Showcase[], s: Showcase): { from: Date; to: Date } {
  const next = list.filter((x) => x.from > s.from).sort((a, b) => a.from.localeCompare(b.from))[0];
  return { from: parseDay(s.from), to: next ? parseDay(next.from) : addDays(startOfDay(new Date()), 1) };
}

export const showcaseLabel = (s: Showcase): string => `Витрина «${s.name}» · с ${dayLabel(parseDay(s.from), false)}`;

// ---------------------------------------------------------------- главное за период
export interface Insight {
  kind: "up" | "info" | "warn";
  /** Текст; фрагменты в ** ** – жирным. */
  text: string;
}

export function insights(o: {
  rows: Row[]; total: HourStat; prev: HourStat | null; period: Period; showcases: Showcase[]; hours: Record<string, HourStat>;
}): Insight[] {
  const out: Insight[] = [];
  const t = o.total;
  if (t.people < 1) return out;

  // 1. Внимание к витрине: смена оформления или прошлый период
  const cur = showcaseAt(o.showcases, addDays(o.period.to, -1));
  const prevSc = cur ? o.showcases.filter((s) => s.from < cur.from).sort((a, b) => b.from.localeCompare(a.from))[0] : undefined;
  let attention: Insight | null = null;
  if (cur && prevSc) {
    const a = showcaseRange(o.showcases, prevSc), b = showcaseRange(o.showcases, cur);
    const sa = sum(rowsIn(o.hours, a.from, a.to)), sb = sum(rowsIn(o.hours, b.from, b.to));
    if (sa.people >= 30 && sb.people >= 30) {
      const ra = ratio(sa.looked, sa.people), rb = ratio(sb.looked, sb.people);
      const better = rb > ra + 0.005, worse = rb < ra - 0.005;
      attention = {
        kind: better ? "up" : worse ? "warn" : "info",
        text: better
          ? `Витрина «${cur.name}» удерживает внимание лучше: доля посмотревших **${pct(sb.looked, sb.people)}** против ${pct(sa.looked, sa.people)} у «${prevSc.name}».`
          : worse
            ? `Витрина «${cur.name}» привлекает меньше: доля посмотревших **${pct(sb.looked, sb.people)}** против ${pct(sa.looked, sa.people)} у «${prevSc.name}».`
            : `Витрины «${cur.name}» и «${prevSc.name}» привлекают одинаково: смотрит **${pct(sb.looked, sb.people)}** прохожих.`,
      };
    }
  }
  if (!attention && o.prev && o.prev.people >= 30) {
    const ra = ratio(o.prev.looked, o.prev.people), rb = ratio(t.looked, t.people);
    const d = (rb - ra) * 100;
    attention = {
      kind: d > 0.5 ? "up" : d < -0.5 ? "warn" : "info",
      text: Math.abs(d) <= 0.5
        ? `Внимание к витрине стабильно: смотрит **${pct(t.looked, t.people)}** прохожих, как и раньше.`
        : `Доля посмотревших **${pct(t.looked, t.people)}** – ${d > 0 ? "больше" : "меньше"} на ${Math.abs(d).toFixed(1).replace(".", ",")} п.п., чем ${prevWord(o.period)}.`,
    };
  }
  if (!attention) attention = { kind: "info", text: `На витрину смотрит **${pct(t.looked, t.people)}** прохожих, притормаживает – ${pct(t.slowed, t.people)}.` };
  out.push(attention);

  // 2. Пик потока и лучший день
  const hb = hourBars(o.rows);
  const peak = hb.reduce((a, b) => (b.passed > a.passed ? b : a), hb[0]);
  const wd = weekdays(o.rows).map((w, i) => ({ ...w, i }));
  const best = wd.filter((w) => w.days > 0).sort((a, b) => b.people - a.people)[0];
  const peakText = peak && peak.passed > 0 ? `Пик потока – **${String(peak.hour).padStart(2, "0")}:00–${String((peak.hour + 1) % 24).padStart(2, "0")}:00**.` : "";
  const bestText = best && wd.filter((w) => w.days > 0).length >= 3 ? ` Больше всего людей – в ${WEEKDAYS_ACC[best.i]}.` : "";
  if (peakText || bestText) out.push({ kind: "info", text: (peakText + bestText).trim() });

  // 3. Где воронка теряет больше всего
  const steps: [string, number, string][] = [];
  if (t.people > 0) steps.push(["«прошли мимо» и «притормозили»", ratio(t.slowed, t.people), "Витрину мало замечают: попробуйте свет, движение или крупный акцент на уровне глаз."]);
  if (t.slowed > 0 && t.looked <= t.slowed) steps.push(["«притормозили» и «посмотрели»", ratio(t.looked, t.slowed), "Замечают, но не разглядывают: проверьте, читается ли оформление с 2–3 метров."]);
  if (t.looked > 0 && t.entered > 0) steps.push(["«посмотрели» и «зашли»", ratio(t.entered, t.looked), "Проверьте вход и навигацию: видна ли дверь, понятно ли, что открыто."]);
  const worst = steps.sort((a, b) => a[1] - b[1])[0];
  if (worst && worst[1] < 1) {
    const oneOf = worst[1] > 0 ? Math.max(2, Math.round(1 / worst[1])) : 0;
    const share = worst[0].includes("зашли") ? `заходит 1 из ${oneOf}` : worst[0].includes("притормозили»") && worst[0].startsWith("«прошли") ? `притормаживает 1 из ${oneOf}` : `смотрит 1 из ${oneOf}`;
    out.push({ kind: "warn", text: `Больше всего теряем между ${worst[0]}${oneOf ? `: ${share}` : ""}. ${worst[2]}` });
  }
  return out;
}

const prevWord = (p: Period) => (p.kind === "today" ? "вчера" : p.kind === "custom" ? "в прошлом таком же периоде" : `в прошлые ${p.kind} ${plural(Number(p.kind), "день", "дня", "дней")}`);

// ---------------------------------------------------------------- деньги и касса
export interface Revenue {
  value: number;
  text: string;
}

export function revenue(t: HourStat, p: BusinessProfile): Revenue | null {
  if (t.entered > 0) {
    const v = (t.entered * p.enterToBuy * p.avgCheck) / 100;
    return { value: v, text: `${num(t.entered)} зашли × ${p.enterToBuy}% покупают × чек ${num(p.avgCheck)} ₽` };
  }
  if (t.looked > 0) {
    const v = (t.looked * p.lookToBuy * p.avgCheck) / 100;
    return { value: v, text: `${num(t.looked)} посмотрели × ${p.lookToBuy}% покупают × чек ${num(p.avgCheck)} ₽` };
  }
  return null;
}

// ---------------------------------------------------------------- пример данных (для показа без камеры)
/** Правдоподобная статистика за 60 дней: будни/выходные, вечерний пик. Только в памяти. */
export function demoHours(now = new Date()): Record<string, HourStat> {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const out: Record<string, HourStat> = {};
  const shape = [0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 62, 85, 110, 150, 170, 160, 150, 175, 210, 240, 190, 120, 0, 0];
  const today = startOfDay(now);
  for (let d = 59; d >= 0; d--) {
    const day = addDays(today, -d);
    const wd = (day.getDay() + 6) % 7;
    const k = [0.86, 0.92, 0.95, 1, 1.12, 1.06, 0.94][wd];
    const fresh = d < 9 ? 1.14 : 1; // новая витрина последние 9 дней
    for (let h = 9; h <= 21; h++) {
      if (d === 0 && h > now.getHours()) break;
      const r = (x: number) => Math.floor(x + rnd()); // случайное округление – доли не теряются на малых числах
      const people = r((shape[h] * k * (0.85 + rnd() * 0.3)) / 7);
      const slowed = r(people * (0.21 + rnd() * 0.04) * fresh);
      const looked = r(slowed * (0.52 + rnd() * 0.08) * fresh);
      const entered = r(people * (0.03 + rnd() * 0.008));
      const returned = r(people * (0.013 + rnd() * 0.005) * fresh);
      const date = new Date(day);
      date.setHours(h);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}-${String(h).padStart(2, "0")}`;
      out[key] = { people, passed: Math.round(people * 0.9), slowed, looked, entered, returned, seconds: 3600 };
    }
  }
  return out;
}

export function demoShowcases(now = new Date()): Showcase[] {
  const t = startOfDay(now);
  return [
    { id: "demo-oct", name: "Октябрь", from: dayKey(addDays(t, -40)) },
    { id: "demo-nov", name: "Ноябрь", from: dayKey(addDays(t, -8)) },
  ];
}
