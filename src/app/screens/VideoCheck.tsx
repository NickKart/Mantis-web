// Проверка на видеофайле: разметка первого кадра → анализ (15 кадров в секунду) → итоги, просмотр с рамками,
// выгрузка (JSON, CSV – как у Python-прототипа) и сохранение в «Записи» (если привязать видео к плану).
import { useEffect, useRef, useState } from "preact/hooks";
import type { ShowcaseDirection } from "../../engine/headpose";
import { defaultConfig } from "../../engine/config";
import { type OverlayBox, Session, type SessionReport } from "../../engine/session";
import { openCalibration } from "../../twin/editors";
import { type RecFrame } from "../../twin/plan";
import { saveRecording } from "../../twin/store";
import { buildVideoTimeline, loadVideo } from "../../twin/video";
import { type ReportContext, exportEvents, exportSummary, exportTracks } from "../../ui/report";
import type { Markup } from "../../ui/draw";
import { drawBoxes, drawMarkup, pickHandle } from "../draw";
import { mmss, num, pct } from "../format";
import { IcArrow, IcClose, IcDownload, IcFile, IcMap, IcPause, IcPlay } from "../icons";
import { Bar, Seg, Switch, go, useCore } from "../ui";

interface Frame {
  t: number;
  boxes: OverlayBox[];
}
type Phase = "pick" | "markup" | "run" | "done";

const KEY = "mantis.video.markup.v2";
function loadSaved(): { markup: Markup; direction: ShowcaseDirection; fps: number } {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s?.markup?.zone?.length === 4) return s;
  } catch {
    /* нет */
  }
  return {
    markup: { zone: [{ x: 0.22, y: 0.52 }, { x: 0.78, y: 0.5 }, { x: 0.89, y: 0.92 }, { x: 0.11, y: 0.93 }], lineEnabled: true, line: [{ x: 0.61, y: 0.44 }, { x: 0.66, y: 0.98 }], entranceEnabled: false, entrance: [{ x: 0.82, y: 0.59 }, { x: 0.92, y: 0.59 }] },
    direction: "camera", fps: 15,
  };
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return resolve();
    v.addEventListener("seeked", () => resolve(), { once: true });
    v.currentTime = t;
  });
}

export function VideoCheck() {
  const c = useCore();
  const saved = useRef(loadSaved());
  const [phase, setPhase] = useState<Phase>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [m, setM] = useState<Markup>(saved.current.markup);
  const [dir, setDir] = useState<ShowcaseDirection>(saved.current.direction);
  const [fps, setFps] = useState(saved.current.fps);
  const [active, setActive] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stat, setStat] = useState("");
  const [live, setLive] = useState({ passed: 0, slowed: 0, looked: 0, entered: 0, returned: 0 });
  const [report, setReport] = useState<SessionReport | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLCanvasElement>(null);
  const frames = useRef<Frame[]>([]);
  const counts = useRef<number[][]>([]);
  const stopReq = useRef(false);
  const started = useRef(0);

  useEffect(() => () => {
    stopReq.current = true;
    if (video) {
      video.pause();
      URL.revokeObjectURL(video.src);
    }
  }, [video]);

  const paint = (boxes: OverlayBox[] | null, handles = false) => {
    const cv = ref.current, v = video;
    if (!cv || !v) return;
    if (cv.width !== v.videoWidth) cv.width = v.videoWidth;
    if (cv.height !== v.videoHeight) cv.height = v.videoHeight;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(v, 0, 0, cv.width, cv.height);
    drawMarkup(ctx, m, { handles, active, hideZoneLabel: !handles });
    if (boxes) drawBoxes(ctx, boxes, { dimOutside: true });
  };
  useEffect(() => {
    if (phase === "markup") paint(null, true);
  }, [phase, m, active, video]);

  const open = async (f: File) => {
    if (!f.type.startsWith("video/") && !/\.(mov|mp4|m4v|webm|mkv|avi)$/i.test(f.name)) return c.toast("Это не похоже на видео. Выберите файл MP4, MOV или WebM.", true);
    try {
      const v = await loadVideo(URL.createObjectURL(f));
      await seekTo(v, Math.min(0.5, (v.duration || 1) / 4));
      setFile(f);
      setVideo(v);
      setPhase("markup");
      void c.ensureDetector().catch((e: Error) => c.toast(`Нейросеть: ${e.message}`, true));
    } catch {
      c.toast("Браузер не смог открыть это видео. Откройте страницу в Chrome или Safari либо перекодируйте ролик в MP4 (H.264).", true);
    }
  };

  const run = async () => {
    const v = video;
    if (!v) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ markup: m, direction: dir, fps }));
    } catch {
      /* нет */
    }
    let det;
    try {
      setStat("Загружаю нейросеть…");
      setPhase("run");
      det = await c.ensureDetector();
    } catch (e) {
      c.toast(`Нейросеть не загрузилась: ${(e as Error).message}`, true);
      setPhase("markup");
      return;
    }
    const W = v.videoWidth, H = v.videoHeight;
    const cfg = defaultConfig();
    cfg.countLineEnabled = m.lineEnabled;
    cfg.countLine = m.line.map((q) => ({ ...q }));
    cfg.showcaseZone = m.zone.map((q) => ({ ...q }));
    cfg.look.showcaseDirection = dir;
    const session = new Session(cfg, W, H, m.entranceEnabled ? m.entrance : null, fps);
    frames.current = [];
    counts.current = [[0, 0, 0, 0, 0, 0]];
    stopReq.current = false;
    started.current = performance.now();
    v.pause();
    const total = Math.max(1, Math.floor(v.duration * fps));
    let avg = 0;
    await seekTo(v, 0);
    for (let k = 0; k < total && !stopReq.current; k++) {
      const tt = k / fps;
      const job = await det.submit(v, W, H);
      const res = await job.result;
      const fr = session.update(tt, res.detections);
      frames.current.push({ t: tt, boxes: fr.boxes });
      paint(fr.boxes);
      const next = k + 1 < total ? seekTo(v, (k + 1) / fps) : Promise.resolve();
      avg = avg ? avg * 0.9 + res.ms * 0.1 : res.ms;
      const row = [Math.round(tt * 10) / 10, session.seen, fr.counters.slowed, fr.counters.looked, fr.returned, fr.entered];
      const last = counts.current[counts.current.length - 1];
      if (row.slice(1).some((x, i) => x !== last[i + 1])) counts.current.push(row);
      if (k % 3 === 0) {
        setProgress((k + 1) / total);
        setLive({ passed: session.seen, slowed: fr.counters.slowed, looked: fr.counters.looked, entered: fr.entered, returned: fr.returned });
        const el = (performance.now() - started.current) / 1000;
        setStat(`${mmss(tt)} / ${mmss(v.duration)} · осталось ~${mmss((el / (k + 1)) * (total - k - 1))} · ${Math.round(avg)} мс на кадр · ${det.backend}`);
      }
      await next;
    }
    const r = session.finish();
    setReport(r);
    setProgress(1);
    setPhase("done");
    setT(0);
    await seekTo(v, 0);
    showAt(0);
  };

  const frameAt = (tt: number): Frame | null => {
    const fs = frames.current;
    if (!fs.length) return null;
    let lo = 0, hi = fs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fs[mid].t <= tt + 1e-3) lo = mid;
      else hi = mid - 1;
    }
    return tt - fs[lo].t < 0.2 ? fs[lo] : null;
  };
  const showAt = (tt: number) => paint(frameAt(tt)?.boxes ?? []);

  // просмотр после анализа
  useEffect(() => {
    const v = video;
    if (phase !== "done" || !v) return;
    let raf = 0;
    const loop = () => {
      showAt(v.currentTime);
      setT(v.currentTime);
      if (!v.paused && !v.ended) raf = requestAnimationFrame(loop);
      else setPlaying(false);
    };
    if (playing) {
      void v.play();
      raf = requestAnimationFrame(loop);
    } else v.pause();
    return () => cancelAnimationFrame(raf);
  }, [playing, phase]);

  const ctx = (): ReportContext | null => report && file ? {
    report, sourceName: file.name, processingSeconds: (performance.now() - started.current) / 1000, backend: c.detector?.backend ?? "", fps, live: false, numberOf: (id) => id,
  } : null;
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  const saveToRecords = async () => {
    const v = video;
    if (!v || !file || !report) return;
    const still = await createImageBitmap(v);
    const plan = c.twin.plan;
    const cal = await openCalibration({
      title: `Привязка видео к плану · ${file.name}`, plan, background: c.twin.background,
      initial: plan.calibrations[`video:${file.name}`] ?? plan.calibrations["video:last"] ?? null, colorIndex: 7, canRemove: false,
      still: () => ({ image: still, boxes: frameAt(v.currentTime)?.boxes.map((b) => b.box) ?? [], width: v.videoWidth, height: v.videoHeight }),
      message: () => "Кадр из видео",
    });
    if (!cal) return;
    c.twin.setCalibration(cal, `video:${file.name}`);
    c.twin.setCalibration(cal, "video:last");
    const tl = buildVideoTimeline(frames.current, v.videoWidth, v.videoHeight, plan, cal);
    if (!tl) return c.toast("Не получилось перевести людей на план – проверьте привязку", true);
    const recFrames: RecFrame[] = tl.times.map((x, i) => ({ t: x, p: tl.points[i] }));
    const name = file.name.replace(/\.[^.]+$/, "");
    const meta = await saveRecording(name, "video", {
      plan: structuredClone(plan), cameras: [{ id: `video:${file.name}`, name: "видео", colorIndex: 7 }], frames: recFrames, counts: counts.current,
    }, file, c.twin.backgroundBlob);
    if (meta) {
      c.toast(`Сохранено в «Записи»: ${name}`);
      go("records", meta.id);
    } else c.toast("Не удалось сохранить (мало места в браузере?)", true);
  };

  const toNorm = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const rep = report;
  const people = rep ? rep.metrics.people : live.passed;
  const result: [string, number, string, string][] = rep ? [
    ["Прошли мимо", rep.metrics.people, "var(--r1)", "людей в зоне камеры"],
    ["Притормозили", rep.counters.slowed, "var(--r2)", `${pct(rep.counters.slowed, people)} от прошедших`],
    ["Посмотрели", rep.counters.looked, "var(--r3)", `${pct(rep.counters.looked, people)} от прошедших`],
    ["Зашли", rep.entered ?? 0, "var(--r4)", rep.entered === null ? "линия входа не задана" : `${pct(rep.entered, people)} от прошедших · ${pct(rep.entered, rep.counters.looked)} от посмотревших`],
    ["Вернулись", rep.returned, "#C2410C", `${pct(rep.returned, people)} от прошедших`],
  ] : [];

  return (
    <div class="main wide">
      <header class="focus-head">
        <button class="btn icon" aria-label="Закрыть" style={{ width: "40px", height: "40px" }} onClick={() => { stopReq.current = true; go("setup"); }}><IcClose size={18} width={2} color="#2370B4" /></button>
        <div class="focus-title"><span>Настройка камеры</span><span class="dot-sep">·</span><span>Проверка на видеофайле</span></div>
        <ol class="stepper">
          {(["Видео", "Разметка", "Анализ", "Итоги"] as const).map((s, i) => {
            const idx = ["pick", "markup", "run", "done"].indexOf(phase);
            return [
              i > 0 ? <li key={`l${i}`} aria-hidden="true" class="step-line" /> : null,
              <li key={s} class={i < idx ? "done" : i === idx ? "on" : ""}><span class="step-btn"><span class="step-num">{i + 1}</span>{s}</span></li>,
            ];
          })}
        </ol>
      </header>
      <div class="setup-body">
        {phase === "pick" && (
          <>
            <div class="setup-intro">
              <h1>Проверка на видеофайле</h1>
              <p class="lead">Перетащите ролик с телефона или камеры – Mantis разберёт его так же, как живую камеру: сколько прошло мимо, притормозило, посмотрело, зашло и вернулось. Видео никуда не отправляется.</p>
            </div>
            <label class={`drop ${drag ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer?.files[0]; if (f) void open(f); }}>
              <IcFile size={28} color="#4A9BD8" />
              <b>Перетащите видео сюда или выберите файл</b>
              <span class="sub">MP4, MOV или WebM · лучше 20–60 секунд, камера неподвижна</span>
              <input type="file" accept="video/*,.mov,.mp4,.m4v,.webm" class="sr-only" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void open(f); }} />
              <span class="btn primary lg">Выбрать видео</span>
            </label>
          </>
        )}
        {phase !== "pick" && video && (
          <div class="setup-grid">
            <section class="setup-frame">
              <div class="frame-head">
                <span class="frame-title">{file?.name}</span>
                <span class="sub">{video.videoWidth}×{video.videoHeight} · {mmss(video.duration)}</span>
                {phase === "markup" && <span class="sub right">Перетаскивайте точки прямо на кадре</span>}
              </div>
              <div class="frame markup-frame" style={{ aspectRatio: `${video.videoWidth} / ${video.videoHeight}` }}>
                <canvas ref={ref} style={{ touchAction: "none", cursor: phase === "markup" ? (active ? "grabbing" : "crosshair") : "default" }}
                  onPointerDown={(e) => {
                    if (phase !== "markup") return;
                    const id = pickHandle(m, toNorm(e), ref.current!.getBoundingClientRect());
                    if (id) { setActive(id); ref.current!.setPointerCapture(e.pointerId); }
                  }}
                  onPointerMove={(e) => {
                    if (!active) return;
                    const mm = /^(zone|line|entrance)(\d)$/.exec(active)!;
                    const next = structuredClone(m);
                    next[mm[1] as "zone"][Number(mm[2])] = toNorm(e);
                    setM(next);
                  }}
                  onPointerUp={() => setActive(null)} />
              </div>
              {phase === "run" && (
                <>
                  <div class="progress"><i style={{ width: `${(progress * 100).toFixed(1)}%` }} /></div>
                  <span class="sub">{stat}</span>
                </>
              )}
              {phase === "done" && (
                <div class="player-row">
                  <button class="btn icon primary" aria-label={playing ? "Пауза" : "Воспроизвести"} onClick={() => setPlaying(!playing)}>{playing ? <IcPause size={16} /> : <IcPlay size={16} />}</button>
                  <input type="range" min={0} max={video.duration} step={0.05} value={t} aria-label="Перемотка" style={{ flex: 1, accentColor: "#1F2937" }}
                    onInput={(e) => { const x = Number((e.target as HTMLInputElement).value); setPlaying(false); setT(x); void seekTo(video, x).then(() => showAt(x)); }} />
                  <span class="s13" style={{ minWidth: "92px", textAlign: "right" }}>{mmss(t)} / {mmss(video.duration)}</span>
                </div>
              )}
            </section>
            <aside class="setup-panel">
              {phase === "markup" && (
                <>
                  <div class="field">
                    <span class="panel-title">Где витрина относительно камеры</span>
                    <Seg label="Где витрина" value={dir} options={[["camera", "Камера в витрине"], ["left", "Слева"], ["right", "Справа"]]} onChange={setDir} />
                  </div>
                  <div class="marks">
                    {([["line", "Линия прохода", "Пересёк – значит прошёл мимо", "#3B82F6", m.lineEnabled], ["entry", "Вход в магазин", "Линия по порогу двери", "#F97316", m.entranceEnabled]] as const).map(([k, tt, d, color, on]) => (
                      <div key={k} class="mark-row">
                        <span class="mark-sw" style={{ background: color }} />
                        <span class="mark-text"><b>{tt}</b><span>{d}</span></span>
                        <Switch on={on} label={tt} onChange={(x) => setM({ ...m, ...(k === "line" ? { lineEnabled: x } : { entranceEnabled: x }) })} />
                      </div>
                    ))}
                  </div>
                  <div class="field">
                    <span class="panel-title">Кадров в секунду</span>
                    <Seg label="Кадров в секунду" value={fps} options={[[5, "5 – быстро"], [10, "10"], [15, "15 – точно"]]} onChange={setFps} />
                    <span class="small muted">15 – как у камеры и iOS-приложения. 5–10 – для быстрой прикидки на слабом компьютере.</span>
                  </div>
                  <div class="panel-foot two">
                    <button class="btn lg" onClick={() => { setVideo(null); setPhase("pick"); }}>Другое видео</button>
                    <button class="btn primary lg" style={{ flex: 1 }} onClick={() => void run()}>Начать анализ<IcArrow size={16} width={2} /></button>
                  </div>
                </>
              )}
              {phase === "run" && (
                <>
                  <span class="panel-title">Идёт анализ · {Math.round(progress * 100)}%</span>
                  <div class="today-list" style={{ borderTop: 0, paddingTop: 0 }}>
                    {([["Прошли мимо", live.passed], ["Притормозили", live.slowed], ["Посмотрели", live.looked], ["Зашли", live.entered], ["Вернулись", live.returned]] as [string, number][]).map(([l, n]) => (
                      <div key={l} class="today-row"><span>{l}</span><span /><b>{num(n)}</b></div>
                    ))}
                  </div>
                  <div class="panel-foot"><button class="btn lg wide" onClick={() => { stopReq.current = true; }}>Остановить и показать итоги</button></div>
                </>
              )}
              {phase === "done" && rep && (
                <>
                  <span class="panel-title">Итоги · {mmss(rep.seconds)} видео</span>
                  <div class="video-result">
                    {result.map(([l, n, color, hint], i) => (
                      <div key={l}>
                        <span class="vr-top"><span>{l}</span><b>{num(n)}</b></span>
                        <Bar value={i === 0 ? (n > 0 ? 1 : 0) : people ? n / people : 0} color={color} thin />
                        <span class="small muted">{hint}</span>
                      </div>
                    ))}
                  </div>
                  <p class="small muted">Направления: → {rep.counters.passedForward} · ← {rep.counters.passedBackward}{rep.metrics.avgSpeed !== null ? ` · скорость ${rep.metrics.avgSpeed.toFixed(1).replace(".", ",")} м/с` : ""} · группы {rep.metrics.groups}</p>
                  <div class="dl-row">
                    <button class="btn" onClick={() => { const x = ctx(); if (x) exportSummary(x, stamp()); }}><IcDownload size={16} />Сводка JSON</button>
                    <button class="btn" onClick={() => { const x = ctx(); if (x) exportEvents(x, stamp()); }}><IcDownload size={16} />События CSV</button>
                    <button class="btn" onClick={() => { const x = ctx(); if (x) exportTracks(x, stamp()); }}><IcDownload size={16} />Люди CSV</button>
                  </div>
                  <div class="panel-foot two" style={{ flexWrap: "wrap" }}>
                    <button class="btn lg" onClick={() => { setReport(null); setPhase("markup"); paint(null, true); }}>Изменить разметку</button>
                    <button class="btn primary lg" style={{ flex: 1 }} onClick={() => void saveToRecords()}><IcMap size={16} />Сохранить в «Записи»</button>
                  </div>
                </>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
