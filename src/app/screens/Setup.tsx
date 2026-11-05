// «Настройка камеры»: список камер и план точки; мастер Источник → Разметка кадра → Проверка → На план.
import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Pt } from "../../engine/geometry";
import type { ShowcaseDirection } from "../../engine/headpose";
import { type Channel, type ChannelConfig, channelColorIndex, channelShort, channelTitle, newChannelConfig } from "../../multi/channel";
import { BEHAVIOR_HINTS, BEHAVIOR_TITLES, type DetectionFilter, LEVEL_HINTS, LEVEL_TITLES, normalizeFilter } from "../../multi/filter";
import { CAMERA_COLORS, calibrationValid, floorPointsUntouched } from "../../twin/plan";
import { mountPlanEditor, openCalibration, type StillFrame } from "../../twin/editors";
import { FULL_FRAME, type Markup, VERTICAL_LINE } from "../../ui/draw";
import { core } from "../core";
import { drawBoxes, drawMarkup, pickHandle, unit } from "../draw";
import { num } from "../format";
import { IcAlert, IcArrow, IcBack, IcCheck, IcClose, IcFile, IcMap, IcOkCircle, IcPencil, IcPlus, IcTrash } from "../icons";
import { LivePlan } from "../media";
import { PeopleProbe, pixelStats, verdict } from "../quality";
import { Seg, Switch, ask, go, useCore, useTick } from "../ui";
import { SourceStep } from "./SourceStep";
import { VideoCheck } from "./VideoCheck";

type Step = "source" | "markup" | "check" | "plan";
const STEPS: [Step, string][] = [["source", "Источник"], ["markup", "Разметка кадра"], ["check", "Проверка"], ["plan", "На план"]];

export function Setup(p: { param: string }) {
  const c = useCore();
  const [id, sub] = p.param.split("/");
  if (p.param === "video") return <VideoCheck />;
  if (p.param === "plan") return <PlanPage />;
  if (!p.param) {
    if (!c.pilot.channels.length) return <Wizard key="new" channel={null} step="source" />;
    return <SetupHome />;
  }
  if (id === "new") return <Wizard key="new" channel={null} step="source" />;
  const ch = c.pilot.channels.find((x) => x.id === id);
  if (!ch) return <SetupHome />;
  const step = (["source", "markup", "check", "plan"].includes(sub) ? sub : "markup") as Step;
  return <Wizard key={ch.id} channel={ch} step={step} />;
}

// ---------------------------------------------------------------- список камер
function SetupHome() {
  const c = useCore();
  const chs = c.pilot.channels;
  useEffect(() => {
    c.pilot.setPreview(true);
    return () => c.pilot.setPreview(false);
  }, []);
  const remove = async (ch: Channel) => {
    if (!(await ask({ title: `Удалить камеру ${channelShort(ch.config)}?`, text: "Камера перестанет считать. Уже собранная статистика останется.", ok: "Удалить", danger: true }))) return;
    await c.pilot.remove(ch.id);
    c.twin.setCalibration(null, ch.id);
  };
  return (
    <main class="main">
      <header class="page-head">
        <div class="titles">
          <h1>Настройка камеры</h1>
          <p class="lead">Камеры этой точки и план. Для каждой камеры один раз отмечаются витрина, линия прохода и вход – по этой разметке Mantis понимает, кто притормозил, посмотрел и зашёл.</p>
        </div>
        <button class="btn primary lg" onClick={() => go("setup", "new")}><IcPlus size={16} width={2} />Добавить камеру</button>
      </header>
      <div class="cam-cards">
        {chs.map((ch, i) => {
          const cal = c.twin.plan.calibrations[ch.id];
          const bound = !!cal && calibrationValid(cal) && !floorPointsUntouched(cal);
          return (
            <section key={ch.id} class="card p20 cam-card">
              <div class="frame" style={{ aspectRatio: "16 / 9" }}>
                <CamFrame ch={ch} markup={ch.config.markup} />
                <span class="over" style={{ left: "10px", top: "10px", fontWeight: 600 }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: CAMERA_COLORS[channelColorIndex(ch.config, i) % CAMERA_COLORS.length] }} />{channelShort(ch.config)}
                </span>
              </div>
              <div class="cam-card-text">
                <b>{channelTitle(ch.config)}</b>
                <span class="sub">{ch.config.kind === "ip" ? "IP-камера" : "Камера компьютера / USB"} · {ch.isCounting ? "считает" : ch.state === "recovering" ? "перезапуск" : "не считает"}</span>
                <span class="cam-badges">
                  <span class={`badge ${ch.config.ready ? "ok" : "warn"}`}>{ch.config.ready ? "кадр размечен" : "нужна разметка"}</span>
                  <span class={`badge ${bound ? "ok" : ""}`}>{bound ? "на плане" : "не на плане"}</span>
                </span>
              </div>
              <div class="cam-card-actions">
                <button class="btn primary" onClick={() => go("setup", ch.id)}>Настроить</button>
                <button class="btn" onClick={() => go("setup", `${ch.id}/plan`)}>На план</button>
                <button class="btn icon ghost right" aria-label="Удалить камеру" title="Удалить камеру" onClick={() => void remove(ch)}><IcTrash size={16} /></button>
              </div>
            </section>
          );
        })}
      </div>
      <div class="row">
        <button class="card p20 link-card grow1" onClick={() => go("setup", "plan")}>
          <span class="link-ic"><IcMap size={20} /></span>
          <span><b>План точки</b><span class="sub">Магазин, витрины, входы, штендеры, стеллажи и зоны. Нужен для схематичного видео, тепла и записей.</span></span>
          <IcArrow size={16} />
        </button>
        <button class="card p20 link-card grow1" onClick={() => go("setup", "video")}>
          <span class="link-ic"><IcFile size={20} /></span>
          <span><b>Проверить на видеофайле</b><span class="sub">Разобрать готовый ролик: те же цифры, что даёт камера, выгрузка в CSV и JSON.</span></span>
          <IcArrow size={16} />
        </button>
      </div>
    </main>
  );
}

/** Картинка камеры с разметкой (список камер, шаг разметки). */
function CamFrame(p: { ch: Channel; markup?: Markup; boxes?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const props = useRef(p);
  props.current = p;
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = 0;
      const s = core.shots.get(props.current.ch.id), cv = ref.current;
      if (!s || !cv || !s.canvas.width) return;
      if (cv.width !== s.canvas.width) cv.width = s.canvas.width;
      if (cv.height !== s.canvas.height) cv.height = s.canvas.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(s.canvas, 0, 0);
      if (props.current.markup) drawMarkup(ctx, props.current.markup, { hideZoneLabel: true });
      if (props.current.boxes && s.fr) drawBoxes(ctx, s.fr.boxes);
    };
    const off = core.onShot((id) => id === props.current.ch.id && !raf && (raf = requestAnimationFrame(draw)));
    draw();
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [p.ch.id]);
  return (
    <>
      <canvas ref={ref} style={{ objectFit: "cover" }} />
      {!core.shots.get(p.ch.id) && <div class="msg">{p.ch.lastError ? `Нет картинки: ${p.ch.lastError}` : p.ch.message || "Подключаю камеру…"}</div>}
    </>
  );
}

// ---------------------------------------------------------------- мастер
function Wizard(p: { channel: Channel | null; step: Step }) {
  const c = useCore();
  const ch = p.channel;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const short = ch ? channelShort(ch.config) : `К${c.pilot.channels.length + 1}`;
  const stepIdx = STEPS.findIndex(([s]) => s === p.step);

  const saveName = () => {
    if (!editing) return;
    setEditing(false);
    const v = draft.trim();
    if (ch && v && v !== short) void c.pilot.upsert({ ...ch.config, alias: v.slice(0, 24) });
  };

  const onSource = async (src: { kind: "webcam" | "ip"; deviceId: string; ip: ChannelConfig["ip"]; label: string }) => {
    if (ch) {
      await c.pilot.upsert({ ...ch.config, kind: src.kind, deviceId: src.deviceId, ip: src.ip });
      go("setup", ch.id);
      return;
    }
    const cfg = newChannelConfig({
      kind: src.kind, deviceId: src.deviceId, ip: src.ip, name: src.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, ""), alias: short,
      markup: { zone: [{ x: 0.22, y: 0.52 }, { x: 0.78, y: 0.5 }, { x: 0.89, y: 0.92 }, { x: 0.11, y: 0.93 }], lineEnabled: true, line: [{ x: 0.61, y: 0.44 }, { x: 0.66, y: 0.98 }], entranceEnabled: false, entrance: [{ x: 0.82, y: 0.59 }, { x: 0.92, y: 0.59 }] },
    });
    await c.pilot.upsert(cfg);
    go("setup", cfg.id);
  };

  return (
    <div class="main wide">
      <header class="focus-head">
        <button class="btn icon" aria-label="Закрыть" style={{ width: "40px", height: "40px" }} onClick={() => go(c.pilot.channels.length ? "setup" : "start")}><IcClose size={18} width={2} color="#2370B4" /></button>
        <div class="focus-title">
          <span>Настройка камеры</span>
          <span aria-hidden="true" class="dot-sep">·</span>
          <span>Камера</span>
          {!editing ? (
            <>
              <span>{short}</span>
              {ch && <button class="btn icon ghost" style={{ width: "36px", height: "36px" }} aria-label="Переименовать камеру" title="Переименовать камеру" onClick={() => { setDraft(short); setEditing(true); }}><IcPencil size={16} width={1.9} /></button>}
            </>
          ) : (
            <>
              <input class="name-input" aria-label="Название камеры" value={draft} maxLength={24} autoFocus
                onInput={(e) => setDraft((e.target as HTMLInputElement).value)} onBlur={saveName}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveName(); } else if (e.key === "Escape") setEditing(false); }} />
              <button class="btn icon primary" style={{ width: "36px", height: "36px", padding: 0 }} aria-label="Сохранить название" onClick={saveName}><IcCheck size={16} width={2.4} /></button>
            </>
          )}
        </div>
        <ol class="stepper">
          {STEPS.map(([s, t], i) => (
            <Fragment key={s}>
              {i > 0 && <li aria-hidden="true" class="step-line" />}
              <li aria-current={i === stepIdx ? "step" : undefined} class={i < stepIdx ? "done" : i === stepIdx ? "on" : ""}>
                <button class="step-btn" disabled={!ch || i === stepIdx} onClick={() => ch && go("setup", `${ch.id}/${s}`)}>
                  <span class="step-num">{i < stepIdx ? <IcCheck size={12} color="#15803D" width={3} /> : i + 1}</span>{t}
                  {s === "plan" && <span class="small muted">(можно позже)</span>}
                </button>
              </li>
            </Fragment>
          ))}
        </ol>
      </header>
      {p.step === "source" && <SourceStep config={ch?.config ?? null} onNext={(s) => void onSource(s)} />}
      {ch && p.step === "markup" && <MarkupStep ch={ch} />}
      {ch && p.step === "check" && <CheckStep ch={ch} />}
      {ch && p.step === "plan" && <PlanStep ch={ch} />}
    </div>
  );
}

/** Включить картинку камеры, пока открыт шаг (если подсчёт не идёт). */
function usePreview(ch: Channel): void {
  useEffect(() => {
    if (!core.pilot.running && ch.state === "idle") void ch.startPreview();
    return () => {
      if (!core.pilot.running) void ch.stopPreview();
    };
  }, [ch.id]);
}

// ---------------------------------------------------------------- шаг 2: разметка
const PLACES: { dir: ShowcaseDirection; label: string; win: [number, number, number, number]; cone: string; cam: [number, number]; hint: string }[] = [
  { dir: "camera", label: "Камера в витрине", win: [6, 2, 32, 3], cone: "M22 6 L6 28 L38 28 Z", cam: [22, 6], hint: "«Посмотрел» – человек повернулся лицом к камере." },
  { dir: "left", label: "Витрина слева", win: [2, 4, 3, 24], cone: "M38 16 L12 4 L12 28 Z", cam: [38, 16], hint: "Камера сбоку: засчитывается поворот головы влево, к витрине." },
  { dir: "right", label: "Витрина справа", win: [39, 4, 3, 24], cone: "M6 16 L32 4 L32 28 Z", cam: [6, 16], hint: "Камера сбоку: засчитывается поворот головы вправо, к витрине." },
];
const SENS: [number, string][] = [[1, "Стандартная – подходит для большинства витрин"], [0, "Высокая – тихая улица, мало людей"], [3, "Низкая – толпа, блики, зеркала"]];
const DEFAULT_ZONE: Pt[] = [{ x: 0.22, y: 0.52 }, { x: 0.78, y: 0.5 }, { x: 0.89, y: 0.92 }, { x: 0.11, y: 0.93 }];
const isFullZone = (z: Pt[]) => z.every((q, i) => Math.abs(q.x - FULL_FRAME[i].x) < 1e-6 && Math.abs(q.y - FULL_FRAME[i].y) < 1e-6);

function MarkupStep(p: { ch: Channel }) {
  const c = useCore();
  const ch = p.ch;
  usePreview(ch);
  useTick(2000);
  const [m, setM] = useState<Markup>(() => structuredClone(ch.config.markup));
  const [dir, setDir] = useState<ShowcaseDirection>(ch.config.direction);
  const [level, setLevel] = useState(ch.config.filter.level);
  const [active, setActive] = useState<string | null>(null);
  const zoneRef = useRef<Pt[]>(isFullZone(m.zone) ? DEFAULT_ZONE.map((q) => ({ ...q })) : m.zone);
  const ref = useRef<HTMLCanvasElement>(null);
  const mRef = useRef(m);
  mRef.current = m;
  const activeRef = useRef(active);
  activeRef.current = active;
  const zoneOn = !isFullZone(m.zone);

  // сохранять сразу (через полсекунды после правки)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void c.pilot.upsert({ ...ch.config, markup: structuredClone(m), direction: dir, filter: normalizeFilter({ ...ch.config.filter, level }) }), 500);
    return () => clearTimeout(t);
  }, [JSON.stringify(m), dir, level]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = 0;
      const s = core.shots.get(ch.id), cv = ref.current;
      if (!cv) return;
      if (s?.canvas.width) {
        if (cv.width !== s.canvas.width) cv.width = s.canvas.width;
        if (cv.height !== s.canvas.height) cv.height = s.canvas.height;
      } else if (!cv.width || cv.width === 300) {
        cv.width = 1280;
        cv.height = 720;
      }
      const ctx = cv.getContext("2d")!;
      if (s?.canvas.width) ctx.drawImage(s.canvas, 0, 0);
      else {
        ctx.fillStyle = "#1F2433";
        ctx.fillRect(0, 0, cv.width, cv.height);
      }
      if (s?.fr) drawBoxes(ctx, s.fr.boxes);
      drawMarkup(ctx, mRef.current, { handles: true, active: activeRef.current });
    };
    const q = () => !raf && (raf = requestAnimationFrame(draw));
    const off = core.onShot((id) => id === ch.id && q());
    draw();
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [ch.id]);
  useEffect(() => {
    const cv = ref.current;
    if (cv) requestAnimationFrame(() => {
      const ctx = cv.getContext("2d")!;
      const s = core.shots.get(ch.id);
      if (s?.canvas.width) ctx.drawImage(s.canvas, 0, 0);
      drawMarkup(ctx, m, { handles: true, active });
    });
  }, [m, active]);

  const toNorm = (e: PointerEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: PointerEvent) => {
    const id = pickHandle(m, toNorm(e), ref.current!.getBoundingClientRect());
    if (!id) return;
    setActive(id);
    ref.current!.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const a = activeRef.current;
    if (!a) return;
    const mm = /^(zone|line|entrance)(\d)$/.exec(a)!;
    const key = mm[1] as "zone" | "line" | "entrance";
    const next = structuredClone(mRef.current);
    next[key][Number(mm[2])] = toNorm(e);
    if (key === "zone") zoneRef.current = next.zone;
    setM(next);
  };
  const onUp = () => setActive(null);

  const toggle = (k: "zone" | "line" | "entry", on: boolean) => {
    const next = structuredClone(m);
    if (k === "zone") next.zone = on ? zoneRef.current.map((q) => ({ ...q })) : FULL_FRAME.map((q) => ({ ...q }));
    if (k === "line") {
      next.lineEnabled = on;
      if (on && !next.line.length) next.line = VERTICAL_LINE.map((q) => ({ ...q }));
    }
    if (k === "entry") next.entranceEnabled = on;
    setM(next);
  };
  const s = core.shots.get(ch.id);
  const px = useMemo(() => (s?.canvas.width ? pixelStats(s.canvas) : null), [s?.at ? Math.floor(s.at / 2000) : 0]);
  const v = verdict(px, null);
  const marks: ["zone" | "line" | "entry", string, string, string, boolean][] = [
    ["zone", "Зона витрины", "Торможение и взгляд считаются только внутри", "#6DB2E6", zoneOn],
    ["line", "Линия прохода", "Пересёк – значит прошёл мимо, с направлением", "#3B82F6", m.lineEnabled],
    ["entry", "Вход в магазин", "Линия по порогу двери – считает зашедших", "#F97316", m.entranceEnabled],
  ];
  const place = PLACES.find((x) => x.dir === dir) ?? PLACES[0];
  const next = async () => {
    await c.pilot.upsert({ ...ch.config, markup: structuredClone(m), direction: dir, filter: normalizeFilter({ ...ch.config.filter, level }), ready: true });
    go("setup", `${ch.id}/check`);
  };
  return (
    <div class="setup-body">
      <div class="setup-intro">
        <h1>Разметка кадра</h1>
        <p class="lead">Здесь вы показываете Mantis, где на кадре витрина, где люди проходят мимо и где вход в магазин. По этой разметке система понимает, кто притормозил, посмотрел и зашёл. Делается один раз для каждой камеры.</p>
      </div>
      <div class="setup-grid">
        <section class="setup-frame" aria-label="Кадр камеры">
          <div class="frame-head">
            <span class="frame-title">Камера {channelShort(ch.config)}{channelTitle(ch.config) !== channelShort(ch.config) ? ` · ${channelTitle(ch.config)}` : ""}</span>
            <span class="sub">{ch.config.kind === "ip" ? "IP" : "USB"}{ch.width ? ` · ${ch.width}×${ch.height}` : ""}{ch.isCounting && ch.fps ? ` · ${Math.round(ch.fps)} к/с` : ""}</span>
            <span class="sub right">Перетаскивайте точки прямо на кадре</span>
          </div>
          <div class="frame markup-frame" style={{ aspectRatio: ch.width && ch.height ? `${ch.width} / ${ch.height}` : "16 / 9" }}>
            <canvas ref={ref} style={{ cursor: active ? "grabbing" : "crosshair", touchAction: "none" }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
            {!s && <div class="msg" style={{ pointerEvents: "none" }}>{ch.lastError ? `Нет картинки: ${ch.lastError}` : ch.message || "Подключаю камеру…"}</div>}
          </div>
          <div class="quality">
            {v.ok ? <IcOkCircle size={18} color="#15803D" width={2} /> : <IcAlert size={18} color="#C2410C" width={2} />}
            <span>{v.text}</span>
          </div>
        </section>
        <aside class="setup-panel">
          <fieldset class="places">
            <legend class="panel-title">Где витрина относительно камеры</legend>
            <div class="place-grid">
              {PLACES.map((x) => (
                <button key={x.dir} aria-pressed={x.dir === dir} class="place" onClick={() => setDir(x.dir)}>
                  <svg width="44" height="30" viewBox="0 0 44 30" fill="none" aria-hidden="true">
                    <rect x={x.win[0]} y={x.win[1]} width={x.win[2]} height={x.win[3]} rx="1.5" fill="#4A9BD8" />
                    <path d={x.cone} fill="#1F2937" fill-opacity=".08" stroke="#1F2937" stroke-opacity=".4" />
                    <circle cx={x.cam[0]} cy={x.cam[1]} r="3" fill="#1F2937" />
                  </svg>
                  <span>{x.label}</span>
                </button>
              ))}
            </div>
            <span class="small muted" style={{ lineHeight: 1.5 }}>{place.hint}</span>
          </fieldset>
          <div class="marks">
            <span class="panel-title" style={{ paddingBottom: "8px" }}>Что считаем</span>
            {marks.map(([k, t, d, color, on]) => (
              <div key={k} class="mark-row">
                <span class="mark-sw" style={{ background: color }} />
                <span class="mark-text"><b>{t}</b><span>{d}</span></span>
                <Switch on={on} label={t} onChange={(v) => toggle(k, v)} />
              </div>
            ))}
          </div>
          <div class="field">
            <label for="sens" class="panel-title">Чувствительность</label>
            <select id="sens" class="select" value={SENS.some(([l]) => l === level) ? level : -1} onChange={(e) => setLevel(Number((e.target as HTMLSelectElement).value))}>
              {SENS.map(([l, t]) => <option key={l} value={l}>{t}</option>)}
              {!SENS.some(([l]) => l === level) && <option value={-1}>{LEVEL_TITLES[level]} – своя настройка</option>}
            </select>
          </div>
          <div class="panel-foot">
            <button class="btn primary lg wide" onClick={() => void next()}>Далее: проверка<IcArrow size={16} width={2} /></button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- шаг 3: проверка
function CheckStep(p: { ch: Channel }) {
  const c = useCore();
  const ch = p.ch;
  useTick(1000);
  const [f, setF] = useState<DetectionFilter>(() => structuredClone(ch.config.filter));
  const [drawZone, setDrawZone] = useState<number | null>(null);
  const [dragExcl, setDragExcl] = useState<[number, number] | null>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const probe = useRef(new PeopleProbe());
  const lastFr = useRef<{ counters: { passed: number; slowed: number; looked: number }; entered: number; returned: number; boxes: number } | null>(null);
  const fRef = useRef(f);
  fRef.current = f;

  // режим проверки: видно, что считается и что отброшено (если подсчёт не идёт – проверочный подсчёт)
  useEffect(() => {
    void c.ensureDetector().catch((e: Error) => c.toast(`Нейросеть: ${e.message}`, true));
    void ch.startTuning(f);
    return () => void ch.stopTuning(false);
  }, [ch.id]);
  useEffect(() => ch.setTuneFilter(f), [JSON.stringify(f)]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = 0;
      const s = core.shots.get(ch.id), cv = ref.current;
      if (!s?.canvas.width || !cv) return;
      if (cv.width !== s.canvas.width) cv.width = s.canvas.width;
      if (cv.height !== s.canvas.height) cv.height = s.canvas.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(s.canvas, 0, 0);
      const u = unit(ctx);
      drawMarkup(ctx, ch.config.markup, { hideZoneLabel: true });
      // зоны исключения
      const W = cv.width, H = cv.height;
      (fRef.current.exclusions ?? []).forEach((z) => {
        ctx.beginPath();
        z.forEach((q, i) => (i ? ctx.lineTo(q.x * W, q.y * H) : ctx.moveTo(q.x * W, q.y * H)));
        ctx.closePath();
        ctx.fillStyle = "rgba(220, 38, 38, 0.18)";
        ctx.fill();
        ctx.strokeStyle = "#DC2626";
        ctx.lineWidth = u * 2;
        ctx.setLineDash([u * 6, u * 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        z.forEach((q) => {
          ctx.beginPath();
          ctx.arc(q.x * W, q.y * H, u * 6, 0, Math.PI * 2);
          ctx.fillStyle = "#FFFFFF";
          ctx.fill();
          ctx.strokeStyle = "#DC2626";
          ctx.stroke();
        });
      });
      // отброшенные детекции – с причиной
      ctx.font = `600 ${Math.round(u * 11)}px "Inter Variable", Inter, sans-serif`;
      for (const r of ch.filterRt.rejected) {
        const b = r.box;
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = u * 1.5;
        ctx.setLineDash([u * 3, u * 3]);
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        ctx.setLineDash([]);
        const tw = ctx.measureText(r.reason).width;
        ctx.fillStyle = "rgba(31,41,55,0.85)";
        ctx.fillRect(b.x1, b.y2, tw + u * 10, u * 18);
        ctx.fillStyle = "#FFFFFF";
        ctx.textBaseline = "middle";
        ctx.fillText(r.reason, b.x1 + u * 5, b.y2 + u * 9);
      }
      if (s.fr) {
        drawBoxes(ctx, s.fr.boxes);
        probe.current.add(s.fr.boxes, H);
        lastFr.current = { counters: s.fr.counters, entered: s.fr.entered, returned: s.fr.returned, boxes: s.fr.boxes.length };
      }
    };
    const off = core.onShot((id) => id === ch.id && !raf && (raf = requestAnimationFrame(draw)));
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [ch.id]);

  const toNorm = (e: PointerEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: PointerEvent) => {
    const q = toNorm(e);
    const r = ref.current!.getBoundingClientRect();
    const ex = f.exclusions ?? [];
    for (let i = 0; i < ex.length; i++) for (let j = 0; j < ex[i].length; j++) {
      if (Math.hypot((ex[i][j].x - q.x) * r.width, (ex[i][j].y - q.y) * r.height) < 22) {
        setDragExcl([i, j]);
        ref.current!.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (drawZone !== null) {
      const z = [{ x: q.x - 0.06, y: q.y - 0.08 }, { x: q.x + 0.06, y: q.y - 0.08 }, { x: q.x + 0.06, y: q.y + 0.08 }, { x: q.x - 0.06, y: q.y + 0.08 }]
        .map((t) => ({ x: Math.min(1, Math.max(0, t.x)), y: Math.min(1, Math.max(0, t.y)) }));
      setF({ ...f, exclusions: [...ex, z] });
      setDrawZone(null);
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!dragExcl) return;
    const q = toNorm(e);
    const ex = structuredClone(f.exclusions ?? []);
    ex[dragExcl[0]][dragExcl[1]] = q;
    setF({ ...f, exclusions: ex });
  };

  const s = core.shots.get(ch.id);
  const px = useMemo(() => (s?.canvas.width ? pixelStats(s.canvas) : null), [s?.at ? Math.floor(s.at / 2000) : 0]);
  const v = verdict(px, probe.current);
  const fr = lastFr.current;
  const working = ch.isCounting || ch.isTuning;
  const save = async (then: () => void) => {
    await c.pilot.upsert({ ...ch.config, filter: normalizeFilter(f), ready: true });
    then();
  };
  const spots = ch.filterRt.staticSpots;
  return (
    <div class="setup-body">
      <div class="setup-intro">
        <h1>Проверка</h1>
        <p class="lead">Пройдите перед камерой или понаблюдайте минуту: цветные рамки – люди, которых Mantis считает, серые пунктирные – отброшенные (с причиной). Если считается лишнее – манекен, плакат, отражение – обведите его зоной исключения.</p>
      </div>
      <div class="setup-grid">
        <section class="setup-frame" aria-label="Проверка на живом кадре">
          <div class="frame-head">
            <span class="frame-title">Камера {channelShort(ch.config)} · режим проверки</span>
            <span class="sub">{c.detectorState === "loading" ? c.detectorText : working && ch.fps ? `${Math.round(ch.fps)} к/с · ${Math.round(ch.msPerFrame)} мс на кадр` : ch.message}</span>
            {drawZone !== null && <span class="sub right" style={{ color: "#B91C1C" }}>Нажмите на кадре, где поставить зону</span>}
          </div>
          <div class="frame markup-frame" style={{ aspectRatio: ch.width && ch.height ? `${ch.width} / ${ch.height}` : "16 / 9" }}>
            <canvas ref={ref} style={{ cursor: drawZone !== null ? "copy" : dragExcl ? "grabbing" : "default", touchAction: "none" }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => setDragExcl(null)} />
            {!s && <div class="msg">{ch.lastError ? `Нет картинки: ${ch.lastError}` : ch.message || "Подключаю камеру…"}</div>}
          </div>
          <div class="quality">
            {v.ok ? <IcOkCircle size={18} color="#15803D" width={2} /> : <IcAlert size={18} color="#C2410C" width={2} />}
            <span>{v.text}</span>
          </div>
          <div class="check-counters">
            {([
              ["В кадре", fr?.boxes ?? 0], ["Прошли", fr?.counters.passed ?? 0], ["Притормозили", fr?.counters.slowed ?? 0],
              ["Посмотрели", fr?.counters.looked ?? 0], ["Зашли", fr?.entered ?? 0], ["Вернулись", fr?.returned ?? 0],
            ] as [string, number][]).map(([t, n]) => <div key={t}><b>{num(n)}</b><span>{t}</span></div>)}
          </div>
          <span class="small muted">{core.pilot.running ? "Подсчёт идёт: счётчики – с запуска подсчёта на этой камере." : "Это проверочный подсчёт – в статистику он не попадает."}</span>
        </section>
        <aside class="setup-panel">
          <div class="field">
            <label class="panel-title" for="lvl">Чувствительность</label>
            <select id="lvl" class="select" value={f.level} onChange={(e) => setF({ ...f, level: Number((e.target as HTMLSelectElement).value) })}>
              {LEVEL_TITLES.map((t, i) => <option key={t} value={i}>{t}</option>)}
            </select>
            <span class="small muted">{LEVEL_HINTS[f.level]}</span>
          </div>
          <div class="field">
            <span class="panel-title">Строгость «посмотрел / притормозил»</span>
            <Seg label="Строгость" value={f.behavior} options={BEHAVIOR_TITLES.map((t, i) => [i, t] as [number, string])} onChange={(b) => setF({ ...f, behavior: b })} />
            <span class="small muted">{BEHAVIOR_HINTS[f.behavior]}</span>
          </div>
          <div class="field">
            <label class="panel-title" for="minh">Минимальный рост фигуры: {f.minHeightPercent ? `${f.minHeightPercent}% кадра` : "без ограничения"}</label>
            <input id="minh" type="range" min={0} max={40} step={1} value={f.minHeightPercent} style={{ accentColor: "#4A9BD8" }}
              onInput={(e) => setF({ ...f, minHeightPercent: Number((e.target as HTMLInputElement).value) })} />
            <span class="small muted">Отсекает мелких людей далеко на улице и отражения.</span>
          </div>
          <div class="field">
            <span class="panel-title">Зоны исключения</span>
            {(f.exclusions ?? []).map((_, i) => (
              <div key={i} class="excl-row"><span>Зона {i + 1} – тяните углы на кадре</span>
                <button class="btn icon ghost" aria-label="Удалить зону" onClick={() => setF({ ...f, exclusions: (f.exclusions ?? []).filter((__, k) => k !== i) })}><IcTrash size={16} /></button></div>
            ))}
            <button class="btn" onClick={() => setDrawZone(drawZone === null ? 1 : null)}>{drawZone !== null ? "Отмена" : "Добавить зону исключения"}</button>
          </div>
          <div class="mark-row" style={{ borderTop: 0, paddingTop: 0 }}>
            <span class="mark-text"><b>Не считать неподвижных</b><span>Кто стоит без движения дольше {f.staticMinutes ?? 3} мин – манекены, плакаты</span></span>
            <Switch on={!!f.ignoreStatic} label="Не считать неподвижных" onChange={(on) => setF({ ...f, ignoreStatic: on })} />
          </div>
          {spots.length > 0 && (
            <button class="btn" onClick={() => {
              const W = ch.width || 1, H = ch.height || 1;
              const zs = spots.map((b) => [{ x: b.x1 / W, y: b.y1 / H }, { x: b.x2 / W, y: b.y1 / H }, { x: b.x2 / W, y: b.y2 / H }, { x: b.x1 / W, y: b.y2 / H }]);
              setF({ ...f, exclusions: [...(f.exclusions ?? []), ...zs] });
            }}>Сделать найденные неподвижные ({spots.length}) зонами исключения</button>
          )}
          <div class="panel-foot two">
            <button class="btn lg" onClick={() => go("setup", ch.id)}><IcBack size={16} width={2} />Разметка</button>
            <button class="btn primary lg" style={{ flex: 1 }} onClick={() => void save(() => go("setup", `${ch.id}/plan`))}>Далее: на план<IcArrow size={16} width={2} /></button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- шаг 4: на план
function PlanStep(p: { ch: Channel }) {
  const c = useCore();
  const ch = p.ch;
  usePreview(ch);
  const cal = c.twin.plan.calibrations[ch.id];
  const bound = !!cal && calibrationValid(cal) && !floorPointsUntouched(cal);
  const index = Math.max(0, c.pilot.channels.indexOf(ch));
  const bind = async () => {
    const still = (): StillFrame => {
      const s = core.shots.get(ch.id);
      return { image: s?.canvas.width ? s.canvas : null, boxes: s?.fr?.boxes.map((b) => b.box) ?? [], width: s?.canvas.width ?? 0, height: s?.canvas.height ?? 0 };
    };
    const r = await openCalibration({
      title: `Привязка к плану · камера ${channelShort(ch.config)}`, plan: c.twin.plan, background: c.twin.background,
      initial: c.twin.calibration(ch.id), colorIndex: channelColorIndex(ch.config, index), canRemove: !!c.twin.calibration(ch.id), still,
      message: () => ch.lastError ?? (ch.message || "Подключаю камеру…"), markName: () => channelShort(ch.config),
    });
    if (r === undefined) return;
    c.twin.setCalibration(r, ch.id);
    c.emit();
  };
  const finish = () => {
    go("live");
    if (!c.pilot.running) c.toast("Камера настроена. Запустите подсчёт кнопкой «Запустить подсчёт».");
  };
  return (
    <div class="setup-body">
      <div class="setup-intro">
        <h1>На план</h1>
        <p class="lead">Привяжите камеру к плану точки – тогда люди с этой камеры появятся на схеме (экран Live, вкладка «Схематичное видео»), в тепловой карте и в записях. Подсчёт работает и без привязки, этот шаг можно сделать позже.</p>
      </div>
      <div class="setup-grid">
        <section class="setup-frame">
          <div class="frame-head">
            <span class="frame-title">План точки</span>
            <span class="sub">{String(c.twin.plan.widthM).replace(".", ",")} × {String(c.twin.plan.depthM).replace(".", ",")} м</span>
            <a class="sub right" href="#/setup/plan">Изменить план</a>
          </div>
          <div class="plan-box"><LivePlan layers={{ heat: false, trails: true, zones: true, cameras: true, speed: false }} height={460} /></div>
        </section>
        <aside class="setup-panel">
          <div class="bind-state">
            {bound ? <IcOkCircle size={20} color="#15803D" width={2} /> : <IcAlert size={20} color="#C2410C" width={2} />}
            <span>{bound ? `Камера ${channelShort(ch.config)} на плане – ${cal.mode === "sector" ? "по сектору обзора" : "по точкам пола"}.` : `Камера ${channelShort(ch.config)} ещё не на плане.`}</span>
          </div>
          <p class="s13" style={{ color: "var(--ink-2)", lineHeight: 1.55 }}>
            Два способа: <b>по полу</b> – 4 точки на полу в кадре и те же точки на плане (точнее всего); <b>по сектору</b> – место камеры, поворот, угол обзора и дальность, если пол не виден.
          </p>
          <button class="btn lg" onClick={() => void bind()}><IcMap size={16} />{bound ? "Изменить привязку" : "Привязать к плану"}</button>
          <div class="panel-foot two">
            <button class="btn lg" onClick={() => go("setup", `${ch.id}/check`)}><IcBack size={16} width={2} />Проверка</button>
            <button class="btn primary lg" style={{ flex: 1 }} onClick={finish}>{bound ? "Готово" : "Пропустить и готово"}<IcArrow size={16} width={2} /></button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- план точки
function PlanPage() {
  const c = useCore();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.replaceChildren();
    const cams = c.pilot.channels.map((ch, i) => ({ id: ch.id, name: channelShort(ch.config), colorIndex: channelColorIndex(ch.config, i) }));
    mountPlanEditor(el, { plan: c.twin.plan, background: c.twin.background, cameras: cams }, (r) => {
      void c.twin.savePlan(r.plan, r.background).then(() => c.emit());
    });
  }, []);
  return (
    <div class="main wide">
      <header class="focus-head">
        <button class="btn icon" aria-label="Закрыть" style={{ width: "40px", height: "40px" }} onClick={() => go("setup")}><IcClose size={18} width={2} color="#2370B4" /></button>
        <div class="focus-title"><span>Настройка камеры</span><span class="dot-sep">·</span><span>План точки</span></div>
        <span class="sub right" style={{ marginLeft: "auto" }}>Изменения сохраняются сами</span>
      </header>
      <div class="setup-body">
        <div class="setup-intro">
          <h1>План точки</h1>
          <p class="lead">Размеры плана в метрах, магазин (углы тянутся, «+» на стороне добавляет угол), витрины и входы на стенах, штендеры, стеллажи и зоны – касса, примерочная, витрина снаружи. Можно подложить картинку плана.</p>
        </div>
        <div ref={box} class="legacy plan-editor-host" />
      </div>
    </div>
  );
}
