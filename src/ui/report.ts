// Итоги анализа видео: подписи событий и выгрузка файлов (JSON, CSV — форматы как у Python-прототипа).

import type { AnalyticsEvent } from "../engine/analytics";
import type { SessionReport } from "../engine/session";

export const fmtTime = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

export const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "");

export function eventTitle(e: AnalyticsEvent): string {
  switch (e.kind) {
    case "passed":
      return e.direction === "forward" ? "прошёл →" : "прошёл ←";
    case "slowed":
      return "притормозил";
    case "looked":
      return "посмотрел";
    case "entered":
      return "зашёл";
    case "returned":
      return "вернулся";
  }
}

export interface ReportContext {
  report: SessionReport;
  sourceName: string;
  processingSeconds: number;
  backend: string;
  fps: number;
  live: boolean;
  numberOf: (id: number) => number;
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csv = (rows: (string | number)[][]): string =>
  "﻿" + rows.map((r) => r.map((v) => (typeof v === "string" && /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v))).join(";")).join("\n");

const r2 = (v: number) => Math.round(v * 100) / 100;

export function exportSummary(ctx: ReportContext, stamp: string): void {
  const r = ctx.report, c = r.counters;
  const json = {
    source: ctx.sourceName,
    width: r.width,
    height: r.height,
    seconds: r2(r.seconds),
    frames: r.frames,
    passed: c.passed,
    passed_forward: c.passedForward,
    passed_backward: c.passedBackward,
    slowed: c.slowed,
    looked: c.looked,
    entered: r.entered,
    returned: r.returned,
    slowed_rate: c.passed ? Math.round((c.slowed / c.passed) * 1000) / 1000 : null,
    looked_rate: c.passed ? Math.round((c.looked / c.passed) * 1000) / 1000 : null,
    metrics: r.metrics,
  };
  download(`mantis_summary_${stamp}.json`, JSON.stringify(json, null, 2), "application/json");
}

export function exportEvents(ctx: ReportContext, stamp: string): void {
  const rows: (string | number)[][] = [["t", "track_id", "event", "direction"]];
  for (const e of [...ctx.report.events].sort((a, b) => a.t - b.t)) rows.push([r2(e.t), e.trackId, e.kind, e.direction]);
  download(`mantis_events_${stamp}.csv`, csv(rows), "text/csv");
}

export function exportTracks(ctx: ReportContext, stamp: string): void {
  const rows: (string | number)[][] = [
    ["track_id", "first_t", "last_t", "duration", "passed", "direction", "slowed", "looked", "zone_time", "slow_time", "look_time", "min_speed"],
  ];
  for (const t of ctx.report.tracks.filter((t) => t.everInZone)) {
    rows.push([
      t.trackId, r2(t.firstT), r2(t.lastT), r2(t.lastT - t.firstT), Number(t.passed), t.direction, Number(t.slowed), Number(t.looked),
      r2(t.zoneTime), r2(t.slowTime), r2(t.lookTime), t.minSpeed === null ? "" : Math.round(t.minSpeed * 1000) / 1000,
    ]);
  }
  download(`mantis_tracks_${stamp}.csv`, csv(rows), "text/csv");
}
