// Live: что происходит у витрины прямо сейчас – кадр с рамками или люди на плане, счётчики за сегодня, камеры.
import { useEffect, useRef, useState } from "preact/hooks";
import { channelShort, channelTitle } from "../../multi/channel";
import type { PlanLayers } from "../../twin/paint";
import { core } from "../core";
import { hhmmss, mmss, num, plural, timeHM } from "../format";
import { IcCam, IcEyeOff, IcFull, IcMap } from "../icons";
import { CameraCanvas, LivePlan } from "../media";
import { Bar, Modal, go, useCore, useTick } from "../ui";

const LAYERS_KEY = "mantis.live.layers";
const loadLayers = (): PlanLayers => {
  try {
    return { heat: true, trails: true, zones: false, cameras: true, speed: false, ...JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") };
  } catch {
    return { heat: true, trails: true, zones: false, cameras: true, speed: false };
  }
};

export function Live() {
  const c = useCore();
  useTick(1000);
  const [tab, setTab] = useState<"camera" | "scheme">(() => (localStorage.getItem("mantis.live.tab") === "scheme" ? "scheme" : "camera"));
  const [layers, setLayers] = useState<PlanLayers>(loadLayers);
  const [camId, setCamId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const viewRef = useRef<HTMLElement>(null);
  const p = c.pilot;
  const chs = p.channels;
  const cam = chs.find((ch) => ch.id === camId) ?? chs[0] ?? null;

  // пока экран открыт и подсчёт не идёт – показываем картинку камер
  useEffect(() => {
    p.setPreview(true);
    return () => p.setPreview(false);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("mantis.live.tab", tab);
      localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
    } catch {
      /* нет */
    }
  }, [tab, layers]);

  const today = c.today();
  const nowAtShowcase = chs.reduce((a, ch) => a + (ch.isCounting && ch.last ? ch.last.boxes.filter((b) => b.inZone).length : 0), 0);
  const base = today.people || 1;
  const todayRows: [string, number, string][] = [
    ["Прошли мимо", today.people, "var(--r1)"],
    ["Притормозили", today.slowed, "var(--r2)"],
    ["Посмотрели", today.looked, "var(--r3)"],
    ["Зашли", today.entered, "var(--r4)"],
    ["Вернулись", today.returned, "#C2410C"],
  ];
  const isScheme = tab === "scheme";
  const sinceText = p.running && p.startedAt
    ? `Подсчёт идёт с ${timeHM(new Date(p.startedAt))} · ${hhmmss((Date.now() - p.startedAt) / 1000)}`
    : p.startedAt ? "Подсчёт остановлен" : "Подсчёт не запущен";
  const calibrated = chs.filter((ch) => core.twin.plan.calibrations[ch.id]).length;

  const fullscreen = async () => {
    const el = viewRef.current;
    if (!el) return;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    else await el.requestFullscreen().catch(() => c.toast("Браузер не разрешил полноэкранный режим", true));
  };
  const camMeta = (ch: (typeof chs)[number]) => {
    const kind = ch.config.kind === "ip" ? "IP" : "USB";
    const fps = ch.isCounting && ch.fps ? ` · ${Math.round(ch.fps)} к/с` : "";
    return `${kind}${fps}`;
  };

  return (
    <main class="main">
      <header class="page-head">
        <div class="titles">
          <h1>Live</h1>
          <p class="lead">Показывает, что происходит у витрины прямо сейчас: людей на плане точки и счётчики за сегодня. Здесь проверяют, что камеры считают верно, и показывают подсчёт клиенту вживую.</p>
          <span class="sub">{sinceText}</span>
        </div>
      </header>

      {!chs.length ? (
        <section class="card empty-card">
          <h2>Камер пока нет</h2>
          <p class="lead">Добавьте камеру и разметьте кадр – после этого здесь появится подсчёт в реальном времени.</p>
          <div><button class="btn primary lg" onClick={() => go("setup", "new")}>Настроить камеру</button></div>
        </section>
      ) : (
        <>
          <div class="live-tabs" role="tablist" aria-label="Вид" style={{ gridTemplateColumns: isScheme ? "minmax(0, 3fr) minmax(0, 7fr)" : "minmax(0, 7fr) minmax(0, 3fr)" }}>
            <button role="tab" aria-selected={!isScheme} onClick={() => setTab("camera")}>
              <IcCam size={20} />
              <span><b>Реалистичное видео</b><small>видео с рамками распознавания</small></span>
            </button>
            <button role="tab" aria-selected={isScheme} onClick={() => setTab("scheme")}>
              <IcMap size={20} />
              <span><b>Схематичное видео</b><small>люди на плане точки</small></span>
            </button>
          </div>

          <div class="row" style={{ alignItems: "flex-start" }}>
            <section ref={viewRef} class="card p20 live-view" style={{ flex: "2 1 600px" }} aria-labelledby="view-h">
              <div class="card-head center">
                <h2 id="view-h">{isScheme ? "План точки" : `Камера ${cam ? channelShort(cam.config) : ""}`}</h2>
                <span class="sub">{isScheme
                  ? `${String(core.twin.plan.widthM).replace(".", ",")} × ${String(core.twin.plan.depthM).replace(".", ",")} м`
                  : cam ? [channelTitle(cam.config) !== channelShort(cam.config) ? channelTitle(cam.config) : "", camMeta(cam)].filter(Boolean).join(" · ") : ""}</span>
                {isScheme && (
                  <div class="chips right" role="group" aria-label="Слои плана">
                    {([["heat", "Тепло"], ["trails", "Следы"], ["zones", "Зоны"], ["cameras", "Камеры"], ["speed", "Скорость"]] as [keyof PlanLayers, string][]).map(([k, t]) => (
                      <button key={k} class="chip" aria-pressed={layers[k]} onClick={() => setLayers({ ...layers, [k]: !layers[k] })}>{t}</button>
                    ))}
                  </div>
                )}
              </div>

              {isScheme ? (
                <>
                  <div class="plan-box live-plan">
                    <LivePlan layers={layers} />
                    {!calibrated && (
                      <div class="plan-note">
                        <span>Камеры ещё не привязаны к плану – люди появятся здесь после привязки.</span>
                        <button class="btn" onClick={() => go("setup", cam ? `${cam.id}/plan` : "plan")}>Привязать камеру</button>
                      </div>
                    )}
                  </div>
                  <div class="legend">
                    <span><span class="lg-dot" style={{ background: "#98A2B3" }} />идёт мимо</span>
                    <span><span class="lg-dot" style={{ background: "#9CCDF0", boxShadow: "0 0 0 2px #6DB2E6 inset" }} />притормозил</span>
                    <span><span class="lg-dot" style={{ background: "#4A9BD8" }} />смотрит на витрину</span>
                    <span><span class="lg-dot" style={{ background: "#EA580C" }} />вернулся</span>
                    <span><span class="lg-dot" style={{ background: "#1E4A73" }} />зашёл</span>
                  </div>
                </>
              ) : cam && (
                <>
                  <div class="frame live-frame" style={{ aspectRatio: cam.width && cam.height ? `${cam.width} / ${cam.height}` : "16 / 9" }}>
                    <CameraCanvas id={cam.id} />
                    {!core.shots.get(cam.id) && <div class="msg">{cam.lastError ? `Нет картинки: ${cam.lastError}` : cam.message || "Подключаю камеру…"}</div>}
                    <span class="over" style={{ right: "12px", top: "12px", fontWeight: 600 }}>
                      <span class="led live" style={{ width: "6px", height: "6px" }} />{channelShort(cam.config)} · {p.running ? (cam.isCounting ? "live" : cam.state === "recovering" ? "перезапуск" : "подключение") : "предпросмотр"}
                    </span>
                    <span class="over" style={{ left: "12px", bottom: "12px" }}>Видео не записывается · лица не распознаются</span>
                  </div>
                  <div class="legend">
                    <span><span class="lg-box" style={{ borderColor: "#38BDF8" }} />прошёл мимо</span>
                    <span><span class="lg-box" style={{ borderColor: "#EAB308" }} />посмотрел на витрину</span>
                    <span><span class="lg-box" style={{ borderColor: "#EF4444" }} />остановился у витрины</span>
                  </div>
                </>
              )}

              <div class="live-actions no-print">
                {c.recording ? (
                  <button class="btn" onClick={() => setNaming(true)}><span class="rec-dot blink" />Остановить запись · {mmss(c.recordingSeconds)}</button>
                ) : (
                  <button class="btn" disabled={!p.running} title={p.running ? "Сохранить фрагмент в «Записи» – только точки на плане, без видео" : "Запись идёт во время подсчёта"}
                    onClick={() => c.startRecording()}><span class="rec-dot" />Записать фрагмент</button>
                )}
                <button class="btn" onClick={fullscreen}><IcFull size={16} />На весь экран</button>
                {p.running ? (
                  <button class="btn primary" onClick={() => void c.stopCounting()}><span class="stop-sq" />Остановить</button>
                ) : (
                  <button class="btn primary" onClick={() => void c.startCounting()}><span class="play-tri" />Запустить подсчёт</button>
                )}
              </div>
              {p.channels.some((ch) => ch.state === "recovering") && (
                <p class="s13" style={{ color: "var(--warn)" }}>{p.channels.filter((ch) => ch.state === "recovering").map((ch) => `${ch.title}: ${ch.message}`).join(" · ")}</p>
              )}
            </section>

            <div class="live-side">
              <section class="card p20" aria-labelledby="now-h" style={{ gap: "16px" }}>
                <div class="card-head" style={{ justifyContent: "space-between" }}>
                  <h2 id="now-h">Сейчас</h2>
                  <span class="small muted">{p.running ? "обновляется каждую секунду" : "подсчёт не идёт"}</span>
                </div>
                <div class="now-big">
                  <span>{p.running ? nowAtShowcase : "–"}</span>
                  <span>{plural(nowAtShowcase, "человек", "человека", "человек")} у витрины</span>
                </div>
                <div class="today-list">
                  <span class="s13 muted">Сегодня</span>
                  {todayRows.map(([label, v, color], i) => (
                    <div key={label} class="today-row">
                      <span>{label}</span>
                      <Bar value={i === 0 ? (v > 0 ? 1 : 0) : v / base} color={color} thin />
                      <b>{num(v)}</b>
                    </div>
                  ))}
                </div>
              </section>

              <section class="card p20" aria-labelledby="cams-h">
                <div class="card-head center" style={{ justifyContent: "space-between" }}>
                  <h2 id="cams-h">Камеры</h2>
                  <label class="check">
                    <input type="checkbox" checked={c.settings.blurCams} onChange={(e) => c.updateSettings({ blurCams: (e.target as HTMLInputElement).checked })} />Скрывать видео
                  </label>
                </div>
                <div class="cam-tiles">
                  {chs.map((ch) => (
                    <button key={ch.id} class={`cam-tile ${ch.id === cam?.id ? "on" : ""}`} onClick={() => { setCamId(ch.id); setTab("camera"); }} title="Показать эту камеру">
                      <div class="cam-thumb">
                        {c.settings.blurCams
                          ? <IcEyeOff size={22} color="#8591A3" />
                          : <CameraCanvas id={ch.id} boxes={false} />}
                        <span class="cam-short">{channelShort(ch.config)}</span>
                      </div>
                      <span class="cam-name">{channelTitle(ch.config)}</span>
                      <span class="cam-meta"><span class={`led ${ch.isCounting ? "" : ch.state === "recovering" ? "warn" : ch.state === "idle" ? "off" : "warn"}`} style={{ width: "6px", height: "6px" }} />{camMeta(ch)}</span>
                    </button>
                  ))}
                </div>
                <button class="btn" onClick={() => go("setup", "new")}>Добавить камеру</button>
              </section>
            </div>
          </div>
        </>
      )}
      {naming && <SaveRecording onClose={() => setNaming(false)} />}
    </main>
  );
}

/** Остановить запись: название фрагмента. */
export function SaveRecording(p: { onClose: () => void }) {
  const [name, setName] = useState(() => {
    const h = new Date().getHours();
    return h < 12 ? "Утро" : h < 17 ? "День" : "Вечер";
  });
  const save = async () => {
    p.onClose();
    const m = await core.stopRecording(name);
    if (m) go("records", m.id);
  };
  return (
    <Modal title="Сохранить фрагмент" onClose={p.onClose}>
      <p class="lead">Запись – это люди на плане и счётчики по времени, без видео. Её можно пересмотреть и сравнить с другой записью.</p>
      <div class="field">
        <label for="rec-name">Название</label>
        <input id="rec-name" class="input" value={name} maxLength={60} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </div>
      <div class="modal-actions">
        <button class="btn lg" onClick={p.onClose}>Продолжить запись</button>
        <button class="btn lg primary" onClick={() => void save()}>Остановить и сохранить</button>
      </div>
    </Modal>
  );
}
