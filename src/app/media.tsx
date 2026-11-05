// Живой кадр камеры и живой план точки на холсте.
import { useEffect, useRef } from "preact/hooks";
import { channelColorIndex, channelShort } from "../multi/channel";
import type { Markup } from "../ui/draw";
import { type PlanLayers, paintPlan } from "../twin/paint";
import { type CameraMark, cameraMark } from "../twin/plan";
import { core } from "./core";
import { drawBoxes, drawMarkup } from "./draw";

/** Кадр камеры пилота: последняя картинка, рамки людей, по желанию – разметка. */
export function CameraCanvas(p: { id: string; boxes?: boolean; markup?: Markup | null; class?: string; onDraw?: (ctx: CanvasRenderingContext2D) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const props = useRef(p);
  props.current = p;
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = 0;
      const c = ref.current;
      const s = core.shots.get(props.current.id);
      if (!c || !s || !s.canvas.width) return;
      if (c.width !== s.canvas.width || c.height !== s.canvas.height) {
        c.width = s.canvas.width;
        c.height = s.canvas.height;
      }
      const ctx = c.getContext("2d")!;
      ctx.drawImage(s.canvas, 0, 0);
      const q = props.current;
      if (q.markup) drawMarkup(ctx, q.markup, { hideZoneLabel: true });
      if (q.boxes !== false && s.fr) drawBoxes(ctx, s.fr.boxes, { dimOutside: true });
      q.onDraw?.(ctx);
    };
    const off = core.onShot((id) => {
      if (id === props.current.id && !raf) raf = requestAnimationFrame(draw);
    });
    draw();
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [p.id]);
  return <canvas ref={ref} class={p.class} />;
}

/** Метки камер на плане. */
export function cameraMarks(): CameraMark[] {
  const plan = core.twin.plan;
  return core.pilot.channels.flatMap((ch, i) => {
    const c = plan.calibrations[ch.id];
    const m = c ? cameraMark(channelShort(ch.config), channelColorIndex(ch.config, i), c, plan) : null;
    return m ? [m] : [];
  });
}

/** Живой план точки: люди со всех камер, тепло за день, зоны, камеры. */
export function LivePlan(p: { layers: PlanLayers; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layers = useRef(p.layers);
  layers.current = p.layers;
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = 0;
      const c = ref.current;
      if (!c) return;
      const m = core.twin;
      paintPlan(c, {
        plan: m.plan, background: m.background, stats: m.stats, heatMax: m.heatMax, people: m.people, occupancy: m.occupancy,
        cameras: cameraMarks(), layers: layers.current,
      });
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const off = core.twin.subscribe(queue);
    const ro = new ResizeObserver(queue);
    if (ref.current) ro.observe(ref.current);
    queue();
    return () => {
      off();
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (c) paintPlan(c, {
      plan: core.twin.plan, background: core.twin.background, stats: core.twin.stats, heatMax: core.twin.heatMax, people: core.twin.people,
      occupancy: core.twin.occupancy, cameras: cameraMarks(), layers: p.layers,
    });
  }, [JSON.stringify(p.layers)]);
  return <canvas ref={ref} style={{ height: `${p.height ?? 520}px` }} />;
}
