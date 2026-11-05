// Записи: загрузка, итоги (из счётчиков записи или, для старых записей, по точкам на плане).
import { FLAG_ENTERED, FLAG_RETURNED, type RecordingData, Timeline } from "../twin/plan";
import { type RecordingMeta, loadRecording } from "../twin/store";
import { blobImage } from "../twin/store";

export interface Totals {
  passed: number;
  slowed: number;
  looked: number;
  returned: number;
  entered: number;
}

export const totalsOf = (row: number[] | undefined): Totals | null =>
  row ? { passed: row[0] ?? 0, slowed: row[1] ?? 0, looked: row[2] ?? 0, returned: row[3] ?? 0, entered: row[4] ?? 0 } : null;

/** Итоги по точкам на плане (если счётчиков в записи нет): уникальные люди и их высшее состояние. */
export function totalsFromFrames(d: RecordingData): Totals {
  const best = new Map<string, { s: number; f: number }>();
  for (const fr of d.frames) for (const p of fr.p) {
    const b = best.get(p.i) ?? { s: 0, f: 0 };
    b.s = Math.max(b.s, p.s);
    b.f |= p.f ?? 0;
    best.set(p.i, b);
  }
  const t: Totals = { passed: best.size, slowed: 0, looked: 0, returned: 0, entered: 0 };
  for (const b of best.values()) {
    if (b.s >= 2) t.slowed++;
    if (b.s >= 3) t.looked++;
    if (b.f & FLAG_RETURNED) t.returned++;
    if (b.f & FLAG_ENTERED) t.entered++;
  }
  return t;
}

export function metaTotals(m: RecordingMeta): Totals {
  return totalsOf(m.totals) ?? { passed: m.people, slowed: 0, looked: 0, returned: 0, entered: 0 };
}

export interface LoadedRec {
  meta: RecordingMeta;
  data: RecordingData;
  tl: Timeline;
  background: ImageBitmap | null;
  video: Blob | null;
  /** Счётчики на момент t. */
  countsAt: (t: number) => Totals;
  /** Моменты, когда кто-то зашёл. */
  enterTimes: number[];
  totals: Totals;
}

export async function loadRec(meta: RecordingMeta): Promise<LoadedRec | null> {
  const r = await loadRecording(meta.id);
  if (!r) return null;
  const tl = new Timeline(r.data.plan, r.data.frames);
  const counts = r.data.counts;
  let countsAt: (t: number) => Totals;
  let enterTimes: number[] = [];
  let totals: Totals;
  if (counts?.length) {
    countsAt = (t) => {
      let row = counts[0];
      for (const c of counts) {
        if (c[0] > t + 1e-3) break;
        row = c;
      }
      return totalsOf(row.slice(1))!;
    };
    for (let i = 1; i < counts.length; i++) for (let k = counts[i - 1][5]; k < counts[i][5]; k++) enterTimes.push(counts[i][0]);
    totals = totalsOf(counts[counts.length - 1].slice(1))!;
  } else {
    // старая запись: события по первым появлениям состояний на плане
    const first = new Map<string, { slow?: number; look?: number; ret?: number; ent?: number; seen: number }>();
    for (const fr of r.data.frames) for (const p of fr.p) {
      const e = first.get(p.i) ?? { seen: fr.t };
      if (p.s >= 2 && e.slow === undefined) e.slow = fr.t;
      if (p.s >= 3 && e.look === undefined) e.look = fr.t;
      if ((p.f ?? 0) & FLAG_RETURNED && e.ret === undefined) e.ret = fr.t;
      if ((p.f ?? 0) & FLAG_ENTERED && e.ent === undefined) e.ent = fr.t;
      first.set(p.i, e);
    }
    const ev = [...first.values()];
    countsAt = (t) => ({
      passed: ev.filter((e) => e.seen <= t).length, slowed: ev.filter((e) => (e.slow ?? 1e9) <= t).length, looked: ev.filter((e) => (e.look ?? 1e9) <= t).length,
      returned: ev.filter((e) => (e.ret ?? 1e9) <= t).length, entered: ev.filter((e) => (e.ent ?? 1e9) <= t).length,
    });
    enterTimes = ev.flatMap((e) => (e.ent !== undefined ? [e.ent] : []));
    totals = totalsFromFrames(r.data);
  }
  return { meta, data: r.data, tl, background: await blobImage(r.background), video: r.video, countsAt, enterTimes, totals };
}
