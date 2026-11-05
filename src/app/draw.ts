// Рисование поверх кадра в стиле макета: рамки людей и разметка (зона витрины, линия прохода, вход).
import type { Pt } from "../engine/geometry";
import type { OverlayBox } from "../engine/session";
import type { Markup } from "../ui/draw";

/** Цвета рамок – как в легенде экрана Live. */
export const BOX = { tracked: "rgba(255,255,255,0.55)", passed: "#38BDF8", looked: "#EAB308", slowed: "#EF4444" };
export const MARK = { zone: "#6DB2E6", zoneLine: "#8CC4EE", line: "#60A5FA", lineHandle: "#3B82F6", arrow: "#93C5FD", entry: "#FB923C" };

/** Пикселей холста на один CSS-пиксель – линии одинаковой толщины на любом видео. */
export function unit(ctx: CanvasRenderingContext2D): number {
  const c = ctx.canvas;
  const w = c instanceof HTMLCanvasElement ? c.getBoundingClientRect().width : 0;
  return w > 0 ? c.width / w : Math.max(1.5, c.width / 900);
}

export function drawBoxes(ctx: CanvasRenderingContext2D, boxes: OverlayBox[], opts: { dimOutside?: boolean } = {}): void {
  const u = unit(ctx);
  ctx.save();
  for (const b of boxes) {
    const { x1, y1, x2, y2 } = b.box;
    const color = b.state === "looked" ? BOX.looked : b.state === "slowed" ? BOX.slowed : b.state === "passed" ? BOX.passed : BOX.tracked;
    ctx.globalAlpha = opts.dimOutside && !b.inZone ? 0.45 : 1;
    ctx.lineWidth = u * (b.state === "tracked" ? 1.5 : 2.5);
    ctx.strokeStyle = color;
    if (b.state === "tracked") ctx.setLineDash([u * 5, u * 4]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
    if (b.returned || b.entered) {
      // метка «вернулся» / «зашёл» над рамкой
      const text = b.entered ? "зашёл" : "вернулся";
      ctx.font = `600 ${Math.round(u * 11)}px "Inter Variable", Inter, sans-serif`;
      const tw = ctx.measureText(text).width;
      const h = u * 18, pad = u * 6;
      const y = Math.max(h, y1 - u * 4);
      ctx.fillStyle = b.entered ? "rgba(30, 74, 115, 0.92)" : "rgba(234, 88, 12, 0.92)";
      ctx.beginPath();
      ctx.roundRect(x1, y - h, tw + pad * 2, h, u * 4);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x1 + pad, y - h / 2 + u * 0.5);
    }
  }
  ctx.restore();
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, u: number): void {
  ctx.font = `600 ${Math.round(u * 12)}px "Inter Variable", Inter, sans-serif`;
  const tw = ctx.measureText(text).width;
  const w = tw + u * 18, h = u * 24;
  ctx.fillStyle = "rgba(31, 41, 55, 0.8)";
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, u * 6);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + u * 0.5);
  ctx.textAlign = "left";
}

const isFull = (z: Pt[]) => z.length === 4 && z.every((p, i) => Math.abs(p.x - [0, 1, 1, 0][i]) < 1e-6 && Math.abs(p.y - [0, 0, 1, 1][i]) < 1e-6);

export function drawMarkup(
  ctx: CanvasRenderingContext2D, m: Markup,
  o: { zone?: boolean; handles?: boolean; active?: string | null; hideZoneLabel?: boolean } = {},
): void {
  const W = ctx.canvas.width, H = ctx.canvas.height, u = unit(ctx);
  const P = (p: Pt): [number, number] => [p.x * W, p.y * H];
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const handle = (p: Pt, stroke: string, id: string, r = 7) => {
    const [x, y] = P(p);
    ctx.beginPath();
    ctx.arc(x, y, u * (o.active === id ? r + 2 : r), 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.lineWidth = u * 2.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  };

  // зона витрины
  if (o.zone !== false && (!isFull(m.zone) || o.handles)) {
    ctx.beginPath();
    m.zone.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    ctx.closePath();
    ctx.fillStyle = "rgba(109, 178, 230, 0.16)";
    ctx.fill();
    ctx.lineWidth = u * 2.5;
    ctx.strokeStyle = MARK.zoneLine;
    ctx.stroke();
    if (!o.hideZoneLabel) {
      const cx = m.zone.reduce((a, p) => a + p.x, 0) / 4, cy = m.zone.reduce((a, p) => a + p.y, 0) / 4;
      pill(ctx, "Зона витрины", cx * W, cy * H + u * 24, u);
    }
    if (o.handles) m.zone.forEach((p, i) => handle(p, MARK.zone, `zone${i}`));
  }

  // линия прохода со стрелками в обе стороны
  if (m.lineEnabled) {
    const [a, b] = [P(m.line[0]), P(m.line[1])];
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.lineWidth = u * 3.5;
    ctx.strokeStyle = MARK.line;
    ctx.stroke();
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len;
    ctx.strokeStyle = MARK.arrow;
    ctx.lineWidth = u * 2.5;
    for (const s of [1, -1]) {
      const ox = mx + tx * u * 22 * s, oy = my + ty * u * 22 * s;
      const sx = ox + nx * u * 8 * s, sy = oy + ny * u * 8 * s;
      const ex = sx + nx * u * 22 * s, ey = sy + ny * u * 22 * s;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.moveTo(ex - nx * u * 7 * s + tx * u * 7, ey - ny * u * 7 * s + ty * u * 7);
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex - nx * u * 7 * s - tx * u * 7, ey - ny * u * 7 * s - ty * u * 7);
      ctx.stroke();
    }
    if (o.handles) m.line.forEach((p, i) => handle(p, MARK.lineHandle, `line${i}`, 6));
  }

  // вход в магазин – пунктир
  if (m.entranceEnabled) {
    const [a, b] = [P(m.entrance[0]), P(m.entrance[1])];
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.lineWidth = u * 3.5;
    ctx.strokeStyle = MARK.entry;
    ctx.setLineDash([u * 9, u * 7]);
    ctx.stroke();
    ctx.setLineDash([]);
    pill(ctx, "Вход", (a[0] + b[0]) / 2, Math.min(a[1], b[1]) - u * 20, u);
    if (o.handles) m.entrance.forEach((p, i) => handle(p, MARK.entry, `entrance${i}`, 6));
  }
  ctx.restore();
}

/** Ближайшая точка разметки под указателем (в CSS-пикселях). */
export function pickHandle(m: Markup, p: Pt, rect: DOMRect, maxPx = 26): string | null {
  const pts: [string, Pt][] = m.zone.map((q, i) => [`zone${i}`, q]);
  if (m.lineEnabled) m.line.forEach((q, i) => pts.push([`line${i}`, q]));
  if (m.entranceEnabled) m.entrance.forEach((q, i) => pts.push([`entrance${i}`, q]));
  let best: string | null = null, bestD = maxPx;
  for (const [id, q] of pts) {
    const d = Math.hypot((q.x - p.x) * rect.width, (q.y - p.y) * rect.height);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
