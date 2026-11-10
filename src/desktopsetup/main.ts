// «Подготовка Mac» – первый запуск приложения Mantis для macOS (desktop-setup.html).
// По шагам: приложение в «Программах», доступ к локальной сети (IP-камеры), камера Mac, автозапуск, питание.
// Перед каждым системным вопросом macOS объясняем простыми словами, что нажать; если доступ запрещён –
// кнопка открывает нужный раздел «Системных настроек». Шаги необязательные, «Готово» – всегда доступно.
// Оболочка открывает эту страницу сама при первом запуске и по меню «Mantis → Подготовка Mac…».

import "@fontsource-variable/inter/index.css";
import { desktopInfo, desktopShell, installState, moveToApplications, openSettings, setAutostart, setupDone } from "../desktop";

type State = "todo" | "wait" | "ok" | "bad" | "info" | "skip";

interface Step {
  id: string;
  title: string;
  why: string;
  state: State;
  /** строка состояния под заголовком */
  note: string;
  /** подсказка, что сейчас спросит macOS */
  ask?: string;
  actions: { label: string; kind?: "primary" | "ghost"; run: () => void | Promise<void> }[];
}

const root = document.getElementById("setup")!;
const inApp = desktopShell === "macos";

const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: light; --blue: #4A9BD8; --ink: #1F2937; --muted: #6B7280; --line: #E5E7EB; --ok: #16A34A; --bad: #DC2626; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #F6F8FB; color: var(--ink); font: 15px/1.5 "Inter Variable", -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 760px; margin: 0 auto; padding: 36px 24px 48px; }
  .head { display: flex; gap: 16px; align-items: center; margin-bottom: 8px; }
  .logo { width: 48px; height: 48px; border-radius: 12px; background: var(--blue); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 22px; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.01em; }
  .lead { color: var(--muted); margin: 6px 0 24px; }
  .progress { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin: 0 0 22px; }
  .progress i { display: block; height: 100%; background: var(--blue); transition: width .3s; }
  .step { display: grid; grid-template-columns: 36px 1fr; gap: 14px; background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin-bottom: 12px; }
  .step.current { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(74,155,216,.15); }
  .mark { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 15px; background: #EEF2F7; color: var(--muted); }
  .ok .mark { background: #DCFCE7; color: var(--ok); }
  .bad .mark { background: #FEE2E2; color: var(--bad); }
  .wait .mark { background: #E0F2FE; color: var(--blue); }
  .wait .mark::after { content: ""; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h2 { font-size: 16px; margin: 4px 0 2px; }
  .why { color: var(--muted); margin: 0; font-size: 14px; }
  .note { margin: 8px 0 0; font-size: 14px; }
  .ok .note { color: var(--ok); }
  .bad .note { color: var(--bad); }
  .ask { margin: 10px 0 0; padding: 10px 12px; border-radius: 10px; background: #F0F7FD; border: 1px solid #D6E9F8; font-size: 14px; }
  .ask b { white-space: nowrap; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  button { font: inherit; font-weight: 600; font-size: 14px; border-radius: 10px; padding: 8px 14px; border: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer; }
  button.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
  button.ghost { border-color: transparent; color: var(--muted); padding-left: 6px; padding-right: 6px; }
  button:disabled { opacity: .5; cursor: default; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 22px; }
  .foot .hint { color: var(--muted); font-size: 13px; }
  .big { font-size: 15px; padding: 11px 20px; }
  .warn { background: #FFF7ED; border: 1px solid #FED7AA; border-radius: 12px; padding: 12px 14px; margin-bottom: 16px; font-size: 14px; }
`;
document.head.append(style);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- шаги

const steps: Step[] = [
  {
    id: "install",
    title: "Mantis в папке «Программы»",
    why: "Так приложение запускается без предупреждений, обновляется и стартует вместе с Mac.",
    state: "wait",
    note: "Проверяю…",
    actions: [],
  },
  {
    id: "lan",
    title: "Доступ к локальной сети",
    why: "Нужен, чтобы находить IP-камеры в сети магазина и получать с них видео. Видео никуда не отправляется.",
    state: "todo",
    note: "",
    actions: [],
  },
  {
    id: "camera",
    title: "Камера Mac или USB-камера",
    why: "Если витрину снимает камера, подключённая к этому Mac. Для IP-камер не нужно.",
    state: "todo",
    note: "",
    actions: [],
  },
  {
    id: "autostart",
    title: "Запуск вместе с Mac",
    why: "После перезагрузки или отключения света Mantis сам откроется и продолжит подсчёт.",
    state: "todo",
    note: "",
    actions: [],
  },
  {
    id: "power",
    title: "Mac не засыпает во время подсчёта",
    why: "Mantis сам не даёт Mac и экрану уснуть, пока идёт подсчёт. Для работы весь день подключите Mac к питанию.",
    state: "ok",
    note: "Ничего делать не нужно",
    actions: [],
  },
];

const step = (id: string) => steps.find((s) => s.id === id)!;

function set(id: string, patch: Partial<Step>): void {
  Object.assign(step(id), patch);
  render();
}

// ---------------------------------------------------------------- 1. «Программы»

async function checkInstall(): Promise<void> {
  const st = await installState();
  if (!st) {
    set("install", { state: "info", note: inApp ? "Не удалось проверить" : "Эта страница – для приложения Mantis для Mac", actions: [] });
    return;
  }
  if (st.inApplications) {
    set("install", { state: "ok", note: "Готово", actions: [] });
    return;
  }
  set("install", {
    state: "bad",
    note: "Mantis запущен не из «Программ» – например, прямо из скачанного образа.",
    actions: [{ label: "Перенести в «Программы»", kind: "primary", run: move }],
  });
}

async function move(): Promise<void> {
  set("install", { state: "wait", note: "Переношу… Если macOS попросит пароль администратора – введите его.", actions: [] });
  const err = await moveToApplications();
  // при успехе приложение перезапускается из «Программ» – сюда не дойдём
  if (err) {
    set("install", {
      state: "bad",
      note: `Не получилось: ${err}. Можно перенести вручную: перетащите Mantis из окна образа в папку «Программы».`,
      actions: [{ label: "Попробовать снова", kind: "primary", run: move }],
    });
  }
}

// ---------------------------------------------------------------- 2. локальная сеть

interface LanResult { status: "allowed" | "blocked" | "waiting" | "no-network" }

async function lanCheck(): Promise<LanResult["status"]> {
  try {
    const r = await fetch("api/lan-check", { cache: "no-store" });
    if (!r.ok) return "blocked";
    return ((await r.json()) as LanResult).status;
  } catch {
    return "blocked";
  }
}

async function askLan(): Promise<void> {
  try {
    localStorage.setItem("mantis.setup.lan", "asked");
  } catch {
    /* нет хранилища */
  }
  set("lan", {
    state: "wait",
    note: "Жду ответа…",
    ask: "Сейчас macOS спросит: «Разрешить приложению Mantis находить устройства в локальной сети?» – нажмите <b>«Разрешить»</b>.",
    actions: [],
  });
  // Первая попытка показывает системный вопрос. Пока он на экране, macOS отвечает «нет доступа» или молчит,
  // поэтому повторяем проверку до 20 секунд: разрешили – сразу «Доступ есть», иначе – подсказка с настройками.
  const until = Date.now() + 20_000;
  let st = await lanCheck();
  while (st !== "allowed" && st !== "no-network" && Date.now() < until) {
    await sleep(1500);
    st = await lanCheck();
  }
  showLan(st);
}

function showLan(st: LanResult["status"]): void {
  if (st === "allowed") set("lan", { state: "ok", note: "Доступ есть", ask: undefined, actions: [] });
  else if (st === "no-network")
    set("lan", {
      state: "info",
      note: "Mac не подключён к сети. Подключите его к Wi-Fi или кабелю магазина и проверьте снова.",
      ask: undefined,
      actions: [{ label: "Проверить снова", run: askLan }],
    });
  else
    set("lan", {
      state: "bad",
      note: "Доступ запрещён – IP-камеры не найдутся.",
      ask: "Откройте настройки и включите переключатель <b>Mantis</b> в разделе «Локальная сеть», затем вернитесь сюда.",
      actions: [
        { label: "Открыть настройки", kind: "primary", run: () => void openSettings("local-network") },
        { label: "Проверить снова", run: askLan },
        { label: "IP-камер нет – пропустить", kind: "ghost", run: () => set("lan", { state: "skip", note: "Пропущено", ask: undefined, actions: [{ label: "Разрешить", run: askLan }] }) },
      ],
    });
}

// ---------------------------------------------------------------- 3. камера

async function cameraPermission(): Promise<PermissionState | null> {
  try {
    const p = await navigator.permissions?.query({ name: "camera" as PermissionName });
    return p?.state ?? null;
  } catch {
    return null;
  }
}

async function askCamera(): Promise<void> {
  set("camera", {
    state: "wait",
    note: "Жду ответа…",
    ask: "Сейчас macOS спросит доступ к камере – нажмите <b>«Разрешить»</b>.",
    actions: [],
  });
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    set("camera", { state: "ok", note: "Доступ есть", ask: undefined, actions: [] });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      set("camera", {
        state: "info",
        note: "Камера не найдена. Если пользуетесь USB-камерой – подключите её и проверьте снова.",
        ask: undefined,
        actions: [{ label: "Проверить снова", run: askCamera }],
      });
      return;
    }
    set("camera", {
      state: "bad",
      note: "Доступ к камере запрещён.",
      ask: "Откройте настройки и включите переключатель <b>Mantis</b> в разделе «Камера», затем перезапустите Mantis.",
      actions: [
        { label: "Открыть настройки", kind: "primary", run: () => void openSettings("camera") },
        { label: "Проверить снова", run: askCamera },
      ],
    });
  }
}

const cameraTodo = (): Partial<Step> => ({
  state: "todo",
  note: "",
  ask: undefined,
  actions: [
    { label: "Разрешить камеру", kind: "primary", run: askCamera },
    { label: "Только IP-камеры – пропустить шаг 3", kind: "ghost", run: () => set("camera", { state: "skip", note: "Пропущено", actions: [{ label: "Разрешить камеру", run: askCamera }] }) },
  ],
});

// ---------------------------------------------------------------- 4. автозапуск

async function autostart(on: boolean): Promise<void> {
  set("autostart", { state: "wait", note: on ? "Включаю…" : "Выключаю…", actions: [] });
  const r = await setAutostart(on);
  showAutostart(r === true, r === null);
}

function showAutostart(on: boolean, failed = false): void {
  if (failed) {
    set("autostart", {
      state: "bad",
      note: "Не получилось. Можно включить вручную в «Объектах входа».",
      actions: [
        { label: "Попробовать снова", kind: "primary", run: () => autostart(true) },
        { label: "Открыть «Объекты входа»", run: () => void openSettings("login-items") },
      ],
    });
  } else if (on) {
    set("autostart", {
      state: "ok",
      note: "Включено. macOS может показать уведомление «Добавлены объекты входа» – это нормально.",
      actions: [{ label: "Выключить", kind: "ghost", run: () => autostart(false) }],
    });
  } else {
    set("autostart", {
      state: "todo",
      note: "",
      actions: [
        { label: "Включить", kind: "primary", run: () => autostart(true) },
        { label: "Не нужно", kind: "ghost", run: () => set("autostart", { state: "skip", note: "Выключено", actions: [{ label: "Включить", run: () => autostart(true) }] }) },
      ],
    });
  }
}

// ---------------------------------------------------------------- вёрстка

function render(): void {
  const done = steps.filter((s) => s.state === "ok" || s.state === "skip" || s.state === "info").length;
  const current = steps.find((s) => s.state === "todo" || s.state === "bad" || s.state === "wait");
  root.innerHTML = `
    <div class="head"><div class="logo">M</div><div><h1>Подготовка Mac</h1></div></div>
    <p class="lead">Пять шагов, чтобы Mantis считал посетителей без перерывов. Каждый шаг можно пропустить и вернуться к нему позже: меню «Mantis» → «Подготовка Mac…».</p>
    ${inApp ? "" : `<div class="warn">Эта страница – для приложения Mantis для Mac. В браузере часть шагов недоступна.</div>`}
    <div class="progress"><i style="width:${(done / steps.length) * 100}%"></i></div>
    ${steps
      .map((s, i) => `
      <section class="step ${s.state} ${s === current ? "current" : ""}" data-id="${s.id}">
        <div class="mark">${s.state === "ok" ? "✓" : s.state === "bad" ? "!" : s.state === "wait" ? "" : s.state === "skip" ? "–" : i + 1}</div>
        <div>
          <h2>${esc(s.title)}</h2>
          <p class="why">${esc(s.why)}</p>
          ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
          ${s.ask ? `<p class="ask">${s.ask}</p>` : ""}
          ${s.actions.length ? `<div class="actions">${s.actions.map((a, j) => `<button class="${a.kind ?? ""}" data-a="${j}">${esc(a.label)}</button>`).join("")}</div>` : ""}
        </div>
      </section>`)
      .join("")}
    <div class="foot">
      <span class="hint">${done === steps.length ? "Всё готово." : `Готово ${done} из ${steps.length}.`}</span>
      <button class="primary big" id="finish">${done === steps.length ? "Открыть Mantis" : "Продолжить в Mantis"}</button>
    </div>`;
  root.querySelectorAll<HTMLElement>("section.step").forEach((el) => {
    const s = step(el.dataset.id!);
    el.querySelectorAll<HTMLButtonElement>("button[data-a]").forEach((b) => {
      b.onclick = () => void s.actions[Number(b.dataset.a)].run();
    });
  });
  document.getElementById("finish")!.onclick = async () => {
    await setupDone();
    location.href = `./?desktop=${desktopShell ?? "macos"}`;
  };
}

// ---------------------------------------------------------------- старт

async function start(): Promise<void> {
  set("lan", {
    state: "todo",
    actions: [
      { label: "Разрешить доступ", kind: "primary", run: askLan },
      { label: "IP-камер нет – пропустить", kind: "ghost", run: () => set("lan", { state: "skip", note: "Пропущено", actions: [{ label: "Разрешить доступ", run: askLan }] }) },
    ],
  });
  set("camera", cameraTodo());
  showAutostart(false);
  render();

  void checkInstall();
  // уже разрешённое показываем сразу, без системных вопросов
  const [cam, info] = await Promise.all([cameraPermission(), desktopInfo()]);
  if (cam === "granted") set("camera", { state: "ok", note: "Доступ есть", actions: [] });
  if (info?.autostart) showAutostart(true);
  // доступ к сети проверяем молча, только если он уже был дан раньше (иначе это вызовет вопрос macOS до объяснения)
  try {
    if (localStorage.getItem("mantis.setup.lan") === "asked" && (await lanCheck()) === "allowed") showLan("allowed");
  } catch {
    /* нет хранилища */
  }
}

void start();
