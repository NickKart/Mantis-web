// Записи: фрагменты работы камер в графическом режиме – люди на плане, события, перемотка и скорость.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type PlanLayers, paintPlan } from "../../twin/paint";
import { HeatCursor } from "../../twin/plan";
import { type RecordingMeta, SOURCE_TITLES, deleteRecording, listRecordings, renameRecording } from "../../twin/store";
import { dayLabel, mmss, num } from "../format";
import { IcBack10, IcFwd10, IcPencil, IcShield, IcTrash } from "../icons";
import { type LoadedRec, loadRec, metaTotals } from "../recs";
import { ask, go, useCore } from "../ui";

const recWhen = (m: RecordingMeta) => {
  const start = new Date(m.created - m.duration * 1000);
  const d = dayLabel(start);
  return `${d}, ${start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
};
export const recCams = (m: RecordingMeta) => (m.source === "video" ? "видео" : m.cameras?.length ? m.cameras.join(", ") : SOURCE_TITLES[m.source]);
export const recStats = (m: RecordingMeta) => {
  const t = metaTotals(m);
  return `${num(t.passed)} прошли · ${num(t.looked)} посмотрели · ${num(t.entered)} зашли`;
};
export { recWhen };

export function Records(p: { param: string }) {
  const c = useCore();
  const [list, setList] = useState<RecordingMeta[] | null>(null);
  const [rec, setRec] = useState<LoadedRec | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [layers, setLayers] = useState<PlanLayers>({ heat: false, trails: true, zones: true, cameras: true, speed: false });
  const canvas = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const heat = useRef(new HeatCursor());

  const reload = async () => setList(await listRecordings());
  useEffect(() => void reload(), []);

  const selId = p.param || list?.[0]?.id || "";
  useEffect(() => {
    const m = list?.find((x) => x.id === selId);
    if (!m) return setRec(null);
    if (rec?.meta.id === m.id) return;
    setPlaying(false);
    setT(0);
    heat.current = new HeatCursor();
    void loadRec(m).then(setRec);
  }, [selId, list]);

  const dur = rec?.tl.duration ?? 0;

  // воспроизведение
  useEffect(() => {
    if (!playing || !rec) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      setT((x) => {
        const n = Math.min(dur, x + dt);
        if (n >= dur) setPlaying(false);
        return n;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, rec]);

  // рисование плана
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !rec) return;
    heat.current.advance(rec.tl, t);
    paintPlan(cv, {
      plan: rec.data.plan, background: rec.background, stats: heat.current.stats(rec.tl), heatMax: heat.current.maxValue,
      people: rec.tl.people(t), occupancy: rec.tl.occupancy(t), layers,
      cameras: [],
    });
  }, [rec, t, layers]);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => rec && paintPlan(cv, { plan: rec.data.plan, background: rec.background, people: rec.tl.people(t), layers, stats: null }));
    ro.observe(cv);
    return () => ro.disconnect();
  }, [rec]);

  // видео записи (если запись сделана по видеофайлу) – синхронно с планом
  const videoUrl = useMemo(() => (rec?.video ? URL.createObjectURL(rec.video) : null), [rec]);
  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = speed;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, speed, videoUrl]);
  useEffect(() => {
    const v = videoRef.current;
    if (v && Math.abs(v.currentTime - t) > 0.35) v.currentTime = t;
  }, [t]);

  const counts = rec?.countsAt(t);
  const start = rec ? new Date(rec.meta.created - rec.meta.duration * 1000) : null;
  const clock = start ? new Date(start.getTime() + t * 1000).toLocaleTimeString("ru-RU") : "";

  const rename = async () => {
    if (!rec) return;
    const name = window.prompt("Название записи", rec.meta.name);
    if (!name?.trim()) return;
    await renameRecording(rec.meta, name);
    setRec({ ...rec, meta: { ...rec.meta, name: name.trim() } });
    await reload();
  };
  const remove = async () => {
    if (!rec) return;
    if (!(await ask({ title: "Удалить запись?", text: `«${rec.meta.name}» удалится из этого браузера.`, ok: "Удалить", danger: true }))) return;
    await deleteRecording(rec.meta.id);
    setRec(null);
    await reload();
    go("records");
  };

  return (
    <main class="main">
      <header class="page-head">
        <div class="titles">
          <h1>Записи</h1>
          <p class="lead">Здесь хранятся записанные фрагменты работы камер. Их можно пересмотреть, перемотать к нужному моменту и посмотреть, как люди ведут себя у витрины.</p>
        </div>
        <button class="btn" onClick={() => {
          go("live");
          if (c.pilot.running) c.startRecording();
          else c.toast("Запустите подсчёт – и нажмите «Записать фрагмент»");
        }}><span class="rec-dot" />Записать новый фрагмент</button>
      </header>

      <aside class="privacy" aria-labelledby="privacy-h">
        <span class="privacy-ic"><IcShield size={20} color="#15803D" width={1.9} /></span>
        <div>
          <h2 id="privacy-h">Запись ведётся в графическом режиме – без лиц людей</h2>
          <p>Mantis не сохраняет видео с камеры. В записи остаются только точки на плане, их маршруты и события: кто прошёл мимо, притормозил, посмотрел на витрину и зашёл. Узнать человека по такой записи нельзя.</p>
        </div>
      </aside>

      {list && !list.length ? (
        <section class="card empty-card">
          <h2>Записей пока нет</h2>
          <p class="lead">Во время подсчёта нажмите «Записать фрагмент» на экране Live – например, вечерний пик или показ для клиента. Запись по видеофайлу делается в «Настройке камеры» → «Проверить на видеофайле».</p>
          <div><button class="btn primary lg" onClick={() => go("live")}>Открыть Live</button></div>
        </section>
      ) : (
        <div class="row" style={{ alignItems: "flex-start" }}>
          <section class="card p20 rec-player" aria-labelledby="player-h">
            <div class="card-head">
              <h2 id="player-h">{rec?.meta.name ?? "…"}</h2>
              {rec && <span class="sub">{recWhen(rec.meta)} · {rec.meta.source === "video" ? "видео" : `камера ${recCams(rec.meta)}`} · схема</span>}
              {rec && (
                <span class="right" style={{ display: "flex", gap: "4px" }}>
                  <button class="btn icon ghost" aria-label="Переименовать" title="Переименовать" onClick={() => void rename()}><IcPencil size={16} /></button>
                  <button class="btn icon ghost" aria-label="Удалить" title="Удалить" onClick={() => void remove()}><IcTrash size={16} /></button>
                </span>
              )}
            </div>
            <div class="rec-stage" role="img" aria-label="Запись в графическом режиме: люди на плане точки показаны цветными точками">
              <canvas ref={canvas} />
              <span class="rec-clock">{clock}</span>
              {counts && (
                <div class="rec-counters">
                  {([["Прошли мимо", counts.passed, "#98A2B3"], ["Притормозили", counts.slowed, "#9CCDF0"], ["Посмотрели", counts.looked, "#4A9BD8"], ["Вернулись", counts.returned, "#EA580C"], ["Зашли", counts.entered, "#1E4A73"]] as [string, number, string][]).map(([l, v, col]) => (
                    <span key={l}><i style={{ background: col }} /><span>{l}</span><b>{num(v)}</b></span>
                  ))}
                </div>
              )}
              {videoUrl && <video ref={videoRef} class="rec-video" src={videoUrl} muted playsInline />}
            </div>
            <div class="rec-timeline">
              <div class="rec-ticks" aria-hidden="true">
                {rec?.enterTimes.map((x, i) => <span key={i} style={{ left: `${(dur ? (x / dur) * 100 : 0).toFixed(2)}%` }} />)}
              </div>
              <input type="range" min={0} max={dur || 1} step={0.1} value={t} aria-label="Перемотка записи" onInput={(e) => setT(Number((e.target as HTMLInputElement).value))} />
            </div>
            <div class="rec-controls">
              <button class="rec-play" aria-label={playing ? "Пауза" : "Воспроизвести"} onClick={() => {
                if (!playing && t >= dur) setT(0);
                setPlaying(!playing);
              }}>
                {playing
                  ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
                  : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>}
              </button>
              <button class="btn ctl-sq" aria-label="Остановить" title="Остановить" onClick={() => { setPlaying(false); setT(0); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              </button>
              <button class="btn ctl" aria-label="Назад на 10 секунд" title="Назад на 10 секунд" onClick={() => setT(Math.max(0, t - 10))}><IcBack10 size={16} width={2} />10 с</button>
              <button class="btn ctl" aria-label="Вперёд на 10 секунд" title="Вперёд на 10 секунд" onClick={() => setT(Math.min(dur, t + 10))}>10 с<IcFwd10 size={16} width={2} /></button>
              <span class="rec-time">{mmss(t)} / {mmss(dur)}</span>
              <button class="btn ctl" aria-pressed={layers.heat} title="Тепловая карта до текущего момента" style={layers.heat ? { background: "var(--accent-soft)", borderColor: "var(--accent-border)" } : undefined}
                onClick={() => setLayers({ ...layers, heat: !layers.heat })}>Тепло</button>
              <button class="btn ctl speed" aria-label="Скорость воспроизведения" onClick={() => setSpeed(speed === 1 ? 2 : speed === 2 ? 4 : speed === 4 ? 0.5 : 1)}>{speed === 0.5 ? "½" : speed}×</button>
            </div>
            <div class="legend small-legend">
              <span><span class="lg-dot" style={{ background: "#98A2B3" }} />идёт мимо</span>
              <span><span class="lg-dot" style={{ background: "#9CCDF0" }} />притормозил</span>
              <span><span class="lg-dot" style={{ background: "#4A9BD8" }} />смотрит на витрину</span>
              <span><span class="lg-dot" style={{ background: "#EA580C" }} />вернулся</span>
              <span><span class="lg-dot" style={{ background: "#1E4A73" }} />зашёл</span>
              <span><span style={{ width: "3px", height: "10px", borderRadius: "2px", background: "#F97316" }} />на шкале – моменты, когда кто-то зашёл</span>
            </div>
          </section>

          <section class="card rec-list" aria-labelledby="list-h">
            <div class="rec-list-head">
              <h2 id="list-h">Все записи</h2>
              <span class="sub">{list ? `${list.length} ${list.length % 10 === 1 && list.length % 100 !== 11 ? "запись" : [2, 3, 4].includes(list.length % 10) && ![12, 13, 14].includes(list.length % 100) ? "записи" : "записей"}` : ""}</span>
            </div>
            {list?.map((m) => (
              <button key={m.id} class="rec-item" aria-pressed={m.id === selId} onClick={() => go("records", m.id)}>
                <span class="rec-thumb"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg></span>
                <span class="rec-item-text">
                  <span class="rec-item-top"><b>{m.name}</b><span>{mmss(m.duration)}</span></span>
                  <span class="small muted">{recWhen(m)} · {recCams(m)}</span>
                  <span class="small" style={{ color: "var(--ink-2)" }}>{recStats(m)}</span>
                </span>
              </button>
            ))}
            {list && list.length >= 2 && <button class="btn" style={{ marginTop: "8px" }} onClick={() => go("compare", "rec")}>Сравнить две записи (A/B)</button>}
          </section>
        </div>
      )}
    </main>
  );
}
