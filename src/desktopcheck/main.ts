// Проверка компьютера для настольного приложения Mantis (desktop-check.html).
// Одна и та же страница открывается в приложении (Mac или Windows) и в Chrome на том же компьютере – результаты сравниваются.
// Проверяет: изоляцию страницы (многопоточность), WebGPU, скорость нейросети на видеокарте и процессоре,
// камеру и работу подсчёта, когда окно свёрнуто или на экране другое приложение.

import { Detector } from "../detector";
import { desktopInfo, desktopShell, keepAwake } from "../desktop";

type Status = "ok" | "bad" | "info" | "wait";
interface Row {
  key: string;
  label: string;
  value: string;
  status: Status;
}

const results: Record<string, string> = {};
const root = document.getElementById("check")!;

// ---------------------------------------------------------------- вёрстка
const css = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b1330; color: #e8edf7; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 24px 60px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: #9aa7c2; margin: 0 0 24px; }
  section { background: #121c40; border: 1px solid #1f2b55; border-radius: 12px; padding: 18px 20px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 0 0 4px; }
  .hint { color: #9aa7c2; font-size: 13px; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 0; border-top: 1px solid #1f2b55; vertical-align: top; }
  td:first-child { color: #b8c3da; width: 46%; padding-right: 12px; }
  .ok::before { content: "✓ "; color: #4cc38a; }
  .bad::before { content: "✕ "; color: #ff6b6b; }
  .wait { color: #9aa7c2; }
  button { background: #4a9bd8; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; margin: 4px 8px 4px 0; }
  button.secondary { background: #24315f; }
  button:disabled { opacity: .5; cursor: default; }
  video { width: 100%; max-height: 300px; background: #000; border-radius: 8px; margin-top: 10px; display: none; }
  .big { font-size: 15px; padding: 12px; border-radius: 8px; background: #0e1736; margin-top: 10px; display: none; white-space: pre-wrap; }
  a { color: #7cc0f2; }
`;
document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

root.innerHTML = `
<div class="wrap">
  <h1>Проверка компьютера для Mantis</h1>
  <p class="sub">Откройте эту страницу в приложении Mantis и в Chrome на этом же компьютере, затем нажмите «Скопировать результаты» в обоих и пришлите. <a href="./">Вернуться в Mantis</a></p>

  <section>
    <h2>1. Окружение</h2>
    <p class="hint">Проверяется само при открытии страницы.</p>
    <table id="t-env"></table>
  </section>

  <section>
    <h2>2. Нейросеть</h2>
    <p class="hint">Скорость распознавания людей на видеокарте и на процессоре. Занимает до минуты.</p>
    <button id="b-nn">Запустить</button>
    <table id="t-nn"></table>
  </section>

  <section>
    <h2>3. Камера</h2>
    <p class="hint">Если система спросит разрешение на камеру – разрешите.</p>
    <button id="b-cam">Проверить камеру</button>
    <video id="v" muted playsinline autoplay></video>
    <table id="t-cam"></table>
  </section>

  <section>
    <h2>4. Работа в свёрнутом окне</h2>
    <p class="hint">Нажмите «Начать», затем сразу сверните окно (⌘M) или переключитесь на другое приложение. Через минуту вернитесь – результат будет здесь.</p>
    <button id="b-bg">Начать, 60 секунд</button>
    <div class="big" id="bg-live"></div>
    <table id="t-bg"></table>
  </section>

  <section>
    <h2>Итог</h2>
    <button id="b-copy">Скопировать результаты</button>
    <button class="secondary" id="b-all">Проверить всё подряд</button>
    <div class="big" id="copy-note"></div>
  </section>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setRow(tableId: string, row: Row): void {
  results[row.key] = row.value;
  const table = $(tableId);
  let tr = table.querySelector<HTMLTableRowElement>(`tr[data-k="${row.key}"]`);
  if (!tr) {
    tr = document.createElement("tr");
    tr.dataset.k = row.key;
    tr.innerHTML = "<td></td><td></td>";
    table.appendChild(tr);
  }
  tr.cells[0].textContent = row.label;
  tr.cells[1].textContent = row.value;
  tr.cells[1].className = row.status;
}

const ms = (x: number) => `${Math.round(x)} мс`;
const fps = (msPerFrame: number) => (msPerFrame > 0 ? `${(1000 / msPerFrame).toFixed(1)} кадров/с` : "–");

// ---------------------------------------------------------------- 1. окружение
async function checkEnv(): Promise<void> {
  const t = "t-env";
  const ua = navigator.userAgent;
  const edge = /Edg\/(\d+)/.exec(ua)?.[1];
  const browser = (edge && desktopShell ? `WebView2 (Edge ${edge})` : null) ?? /Chrome\/(\d+)/.exec(ua)?.[0] ?? (/Version\/([\d.]+).*Safari/.exec(ua) ? `WebKit, Safari ${/Version\/([\d.]+)/.exec(ua)![1]}` : "WebKit (системный движок macOS)");
  setRow(t, { key: "where", label: "Где открыто", value: desktopShell ? `приложение Mantis (${desktopShell})` : "браузер", status: "info" });
  setRow(t, { key: "engine", label: "Движок", value: browser, status: "info" });
  setRow(t, { key: "cores", label: "Ядер процессора", value: String(navigator.hardwareConcurrency || "?"), status: "info" });
  setRow(t, {
    key: "isolated",
    label: "Многопоточность (crossOriginIsolated)",
    value: self.crossOriginIsolated ? "есть" : "нет – нейросеть на процессоре будет в один поток",
    status: self.crossOriginIsolated ? "ok" : "bad",
  });

  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu;
  if (!gpu) {
    setRow(t, { key: "webgpu", label: "WebGPU (видеокарта)", value: "нет", status: "bad" });
  } else {
    try {
      const a = await gpu.requestAdapter();
      const info = a?.info;
      const desc = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(" · ") : "";
      setRow(t, { key: "webgpu", label: "WebGPU (видеокарта)", value: a ? `есть${desc ? ` – ${desc}` : ""}` : "есть, но адаптер не выдан", status: a ? "ok" : "bad" });
    } catch (e) {
      setRow(t, { key: "webgpu", label: "WebGPU (видеокарта)", value: `ошибка: ${(e as Error).message}`, status: "bad" });
    }
  }

  if (desktopShell) {
    const info = await desktopInfo();
    setRow(t, {
      key: "shell",
      label: "Связь с приложением",
      value: info
        ? `работает – версия ${info.version}${info.os ? `, ${info.os}` : ""}, компьютер «${info.hostname}», автозапуск ${info.autostart ? "включён" : "выключен"}`
        : "не отвечает",
      status: info ? "ok" : "bad",
    });
  }

  try {
    const r = await fetch(new URL("api/agent", location.href), { cache: "no-store" });
    const j = r.ok ? ((await r.json()) as { agent?: string; version?: string }) : null;
    setRow(t, {
      key: "bridge",
      label: "Мост IP-камер",
      value: j?.agent === "mantis" ? `работает (${j.version})` : "нет – IP-камеры здесь недоступны",
      status: j?.agent === "mantis" ? "ok" : "info",
    });
  } catch {
    setRow(t, { key: "bridge", label: "Мост IP-камер", value: "нет – IP-камеры здесь недоступны", status: "info" });
  }
}

// ---------------------------------------------------------------- 2. нейросеть
function syntheticFrame(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 1280;
  c.height = 720;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, "#556");
  grad.addColorStop(1, "#bba");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1280, 720);
  // несколько «фигур», чтобы постобработка тоже работала
  g.fillStyle = "#222";
  for (let i = 0; i < 4; i++) g.fillRect(200 + i * 250, 220, 80, 380);
  return c;
}

async function bench(d: Detector, source: CanvasImageSource, w: number, h: number, n: number): Promise<{ avg: number; wall: number; people: number }> {
  await d.detect(source, w, h); // прогрев
  let sum = 0;
  let people = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const r = await d.detect(source, w, h);
    sum += r.ms;
    people = Math.max(people, r.detections.length);
  }
  return { avg: sum / n, wall: (performance.now() - t0) / n, people };
}

async function checkNn(): Promise<void> {
  const t = "t-nn";
  const btn = $<HTMLButtonElement>("b-nn");
  btn.disabled = true;
  const frame = syntheticFrame();
  const modes: { key: string; label: string; gpu: boolean; threads: number }[] = [
    { key: "nn_gpu", label: "На видеокарте (WebGPU)", gpu: true, threads: 0 },
    { key: "nn_cpu", label: "На процессоре, несколько потоков", gpu: false, threads: 0 },
    { key: "nn_cpu1", label: "На процессоре, один поток", gpu: false, threads: 1 },
  ];
  for (const m of modes) {
    setRow(t, { key: m.key, label: m.label, value: "загружаю…", status: "wait" });
    const started = performance.now();
    let d: Detector | null = null;
    try {
      d = await Detector.createExact(m.gpu, m.threads, (s) => setRow(t, { key: m.key, label: m.label, value: s, status: "wait" }));
      const load = performance.now() - started;
      if (m.gpu && !d.backend.startsWith("WebGPU")) throw new Error("WebGPU недоступен");
      const r = await bench(d, frame, frame.width, frame.height, 20);
      setRow(t, { key: m.key, label: m.label, value: `${ms(r.avg)} на кадр · ${fps(r.wall)} · запуск ${ms(load)}`, status: "ok" });
    } catch (e) {
      setRow(t, { key: m.key, label: m.label, value: `не работает: ${(e as Error).message}`, status: "bad" });
    } finally {
      d?.dispose();
    }
  }
  btn.disabled = false;
}

// ---------------------------------------------------------------- 3. камера
let stream: MediaStream | null = null;
let best: Detector | null = null;

async function bestDetector(): Promise<Detector> {
  best ??= await Detector.create();
  return best;
}

async function checkCam(): Promise<void> {
  const t = "t-cam";
  const btn = $<HTMLButtonElement>("b-cam");
  btn.disabled = true;
  const video = $<HTMLVideoElement>("v");
  try {
    setRow(t, { key: "cam", label: "Доступ к камере", value: "жду разрешения…", status: "wait" });
    stream ??= await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    video.style.display = "block";
    await video.play().catch(() => undefined);
    await new Promise((r) => (video.readyState >= 2 ? r(null) : video.addEventListener("loadeddata", () => r(null), { once: true })));
    const track = stream.getVideoTracks()[0];
    setRow(t, { key: "cam", label: "Доступ к камере", value: `есть – ${track.label || "камера"}, ${video.videoWidth}×${video.videoHeight}`, status: "ok" });
    const devices = await navigator.mediaDevices.enumerateDevices();
    setRow(t, { key: "cams", label: "Камер найдено", value: String(devices.filter((d) => d.kind === "videoinput").length), status: "info" });

    setRow(t, { key: "cam_nn", label: "Распознавание на кадрах камеры", value: "считаю…", status: "wait" });
    const d = await bestDetector();
    const r = await bench(d, video, video.videoWidth, video.videoHeight, 30);
    setRow(t, { key: "cam_nn", label: "Распознавание на кадрах камеры", value: `${d.backend}: ${ms(r.avg)} на кадр · ${fps(r.wall)} · людей в кадре до ${r.people}`, status: "ok" });
  } catch (e) {
    const err = e as Error;
    setRow(t, { key: "cam", label: "Доступ к камере", value: `не получилось: ${err.name} ${err.message}`, status: "bad" });
  }
  btn.disabled = false;
}

// ---------------------------------------------------------------- 4. свёрнутое окно
async function checkBackground(): Promise<void> {
  const t = "t-bg";
  const btn = $<HTMLButtonElement>("b-bg");
  const live = $("bg-live");
  btn.disabled = true;
  live.style.display = "block";
  live.textContent = "Загружаю нейросеть…";
  await keepAwake(true);
  try {
    const d = await bestDetector();
    const video = $<HTMLVideoElement>("v");
    const useCam = !!stream && video.readyState >= 2;
    const src: CanvasImageSource = useCam ? video : syntheticFrame();
    const w = useCam ? video.videoWidth : 1280;
    const h = useCam ? video.videoHeight : 720;

    const DURATION = 60_000;
    const stats = { visible: { frames: 0, time: 0 }, hidden: { frames: 0, time: 0 } };
    let maxGap = 0;
    let last = performance.now();
    let hiddenEver = false;
    const tick = window.setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 250);

    const isAway = () => document.visibilityState === "hidden" || !document.hasFocus();
    const t0 = performance.now();
    let prev = t0;
    while (performance.now() - t0 < DURATION) {
      await d.detect(src, w, h);
      const now = performance.now();
      const away = isAway();
      if (away) hiddenEver = true;
      const bucket = away ? stats.hidden : stats.visible;
      bucket.frames++;
      bucket.time += now - prev;
      prev = now;
      live.textContent = `Идёт проверка: ${Math.ceil((DURATION - (now - t0)) / 1000)} с · ${useCam ? "кадры с камеры" : "тестовый кадр"} · окно ${away ? "не на экране" : "на экране"}`;
    }
    clearInterval(tick);

    const rate = (b: { frames: number; time: number }) => (b.time > 0 ? (b.frames * 1000) / b.time : 0);
    const vis = rate(stats.visible);
    const hid = rate(stats.hidden);
    setRow(t, { key: "bg_visible", label: "Окно на экране", value: stats.visible.frames ? `${vis.toFixed(1)} кадров/с` : "–", status: "info" });
    if (!hiddenEver) {
      setRow(t, { key: "bg_hidden", label: "Окно свёрнуто / за другим приложением", value: "окно не сворачивали – повторите и сверните окно", status: "bad" });
    } else {
      const okHidden = vis === 0 ? hid > 0 : hid >= vis * 0.6;
      setRow(t, {
        key: "bg_hidden",
        label: "Окно свёрнуто / за другим приложением",
        value: `${hid.toFixed(1)} кадров/с${vis ? ` (${Math.round((hid / vis) * 100)}% от скорости на экране)` : ""}`,
        status: okHidden ? "ok" : "bad",
      });
    }
    setRow(t, { key: "bg_gap", label: "Самая долгая пауза таймера", value: ms(maxGap), status: maxGap < 2000 ? "ok" : "bad" });
    live.textContent = "Готово.";
  } catch (e) {
    live.textContent = `Ошибка: ${(e as Error).message}`;
  } finally {
    await keepAwake(false);
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- итог
async function copyResults(): Promise<void> {
  const text = [
    `Mantis – проверка компьютера, ${new Date().toLocaleString("ru-RU")}`,
    `UA: ${navigator.userAgent}`,
    ...Object.entries(results).map(([k, v]) => `${k}: ${v}`),
  ].join("\n");
  const note = $("copy-note");
  note.style.display = "block";
  try {
    await navigator.clipboard.writeText(text);
    note.textContent = "Скопировано. Вставьте в чат.\n\n" + text;
  } catch {
    note.textContent = "Не получилось скопировать автоматически – выделите текст ниже и скопируйте (⌘C).\n\n" + text;
  }
}

$("b-nn").onclick = () => void checkNn();
$("b-cam").onclick = () => void checkCam();
$("b-bg").onclick = () => void checkBackground();
$("b-copy").onclick = () => void copyResults();
$("b-all").onclick = async () => {
  await checkNn();
  await checkCam();
  $("t-bg").scrollIntoView({ behavior: "smooth" });
};

void checkEnv();
