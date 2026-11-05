// Метрика «Вернулись»: прошёл мимо, развернулся и вернулся к витрине.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/engine/config";
import { Session } from "../src/engine/session";
import type { RawDetection } from "../src/engine/bytetrack";

const W = 1280, H = 720;
const person = (x: number): RawDetection => ({
  box: { x1: x - 40, y1: 300, x2: x + 40, y2: 560 }, score: 0.9,
  keypoints: Array.from({ length: 17 }, () => ({ x, y: 400, conf: 0.1 })),
});

function walk(xs: number[]): Session {
  const cfg = defaultConfig();
  cfg.showcaseZone = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const s = new Session(cfg, W, H, null, 15);
  xs.forEach((x, i) => s.update(i / 15, [person(x)]));
  return s;
}
const range = (a: number, b: number, step: number) => Array.from({ length: Math.floor(Math.abs(b - a) / step) + 1 }, (_, i) => a + Math.sign(b - a) * i * step);

describe("вернулись", () => {
  it("прошёл мимо и не вернулся – 0", () => {
    expect(walk(range(100, 1100, 12)).returnedCount).toBe(0);
  });
  it("прошёл вперёд, развернулся и пришёл обратно – 1", () => {
    const s = walk([...range(100, 800, 12), ...range(800, 350, 12)]);
    expect(s.returnedCount).toBe(1);
    expect(s.events.filter((e) => e.kind === "returned")).toHaveLength(1);
  });
  it("топчется на месте – не считается", () => {
    const xs = Array.from({ length: 120 }, (_, i) => 500 + Math.sin(i / 3) * 25);
    expect(walk(xs).returnedCount).toBe(0);
  });
});
