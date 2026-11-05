// Проверка кадра: светло ли, нет ли бликов, видны ли люди в полный рост (по точкам скелета нейросети).
import type { OverlayBox } from "../engine/session";

export interface PixelStats {
  mean: number;
  glare: number;
  dark: number;
}

const probe = document.createElement("canvas");
probe.width = 160;
probe.height = 90;

export function pixelStats(src: CanvasImageSource): PixelStats | null {
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0, probe.width, probe.height);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let sum = 0, glare = 0, dark = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += y;
      if (y > 248) glare++;
      if (y < 18) dark++;
    }
    return { mean: sum / n, glare: glare / n, dark: dark / n };
  } catch {
    return null;
  }
}

/** Копилка наблюдений за людьми на проверке. */
export class PeopleProbe {
  frames = 0;
  boxes = 0;
  full = 0;
  heightSum = 0;

  add(boxes: OverlayBox[], frameH: number): void {
    this.frames++;
    for (const b of boxes) {
      const k = b.keypoints;
      if (!k) continue;
      this.boxes++;
      this.heightSum += (b.box.y2 - b.box.y1) / Math.max(1, frameH);
      const head = Math.max(k[0]?.conf ?? 0, k[1]?.conf ?? 0, k[2]?.conf ?? 0);
      const feet = Math.max(k[15]?.conf ?? 0, k[16]?.conf ?? 0);
      if (head > 0.4 && feet > 0.4) this.full++;
    }
  }
}

export interface Verdict {
  ok: boolean;
  text: string;
}

export function verdict(px: PixelStats | null, people: PeopleProbe | null): Verdict {
  const issues: string[] = [];
  if (px) {
    if (px.mean < 45 || px.dark > 0.45) issues.push("кадр тёмный – добавьте света или поверните камеру");
    if (px.glare > 0.08) issues.push("в кадре блики – сместите камеру или прикройте стекло от отражений");
  }
  if (people && people.boxes >= 8) {
    const fullShare = people.full / people.boxes;
    const h = people.heightSum / people.boxes;
    if (fullShare < 0.4) issues.push("люди видны не целиком – пол должен быть в кадре, чтобы видеть ноги");
    if (h < 0.12) issues.push("люди в кадре мелкие – камера далеко, подсчёт будет пропускать");
  }
  if (issues.length) return { ok: false, text: `Стоит поправить: ${issues.join("; ")}.` };
  if (people && people.boxes >= 8) return { ok: true, text: "Кадр подходит: люди видны в полный рост, пол в кадре, бликов нет." };
  return { ok: true, text: px ? "Кадр светлый, бликов нет. Людей в полный рост проверим на шаге «Проверка»." : "Жду кадр камеры…" };
}
