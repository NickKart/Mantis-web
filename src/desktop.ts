// Настольная оболочка Mantis (Windows и macOS, Tauri): страница та же, но открыта внутри приложения.
// Оболочка открывает страницу с ?desktop=windows или ?desktop=macos и даёт несколько команд через IPC Tauri:
// запрет сна, автозапуск при входе в систему, сведения о компьютере, выход.
// В обычном браузере всё это недоступно – функции возвращают null / false.

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriInternals {
  invoke: Invoke;
}

const params = new URLSearchParams(location.search);
const FLAG = "mantis.desktop";

/** Название платформы оболочки: "windows", "macos" или null (обычный браузер). */
export const desktopShell: string | null = (() => {
  const q = params.get("desktop");
  try {
    // запоминаем: после перезагрузки страницы без параметра (F5) режим остаётся
    if (q) sessionStorage.setItem(FLAG, q);
    return q ?? sessionStorage.getItem(FLAG) ?? (hasIpc() ? ipcPlatform() : null);
  } catch {
    return q ?? (hasIpc() ? ipcPlatform() : null);
  }
})();

export const isDesktop = desktopShell !== null;

function ipcPlatform(): string {
  return /Mac/i.test(navigator.platform || navigator.userAgent) ? "macos" : "windows";
}

function hasIpc(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.invoke === "function";
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const ipc = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!ipc?.invoke) return null;
  try {
    return (await ipc.invoke(cmd, args)) as T;
  } catch (e) {
    console.warn("[mantis] команда оболочки не выполнилась:", cmd, e);
    return null;
  }
}

export interface DesktopInfo {
  version: string;
  hostname: string;
  autostart: boolean;
  /** Версия системы, например «macOS 26.1 (arm64)» – сообщает оболочка для Mac. */
  os?: string;
}

export function desktopInfo(): Promise<DesktopInfo | null> {
  return call<DesktopInfo>("app_info");
}

// В обычном браузере (и у Mantis Агента) экран держит Wake Lock: снимается, когда вкладка уходит в фон,
// поэтому при возвращении на вкладку берём его снова.
let wakeWanted = false;
let wakeLock: { release: () => Promise<void> } | null = null;
async function browserWake(on: boolean): Promise<void> {
  wakeWanted = on;
  const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
  if (!wl) return;
  try {
    if (on && !wakeLock) wakeLock = await wl.request("screen");
    else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null; // вкладка не на экране – попробуем при возвращении
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeWanted) {
    wakeLock = null;
    void browserWake(true);
  }
});

/** Не давать компьютеру и экрану засыпать, пока идёт пилот. */
export async function keepAwake(on: boolean): Promise<void> {
  if (hasIpc()) await call("keep_awake", { on });
  else await browserWake(on);
}

// ---------------------------------------------------------------- Mantis Агент (страницу отдаёт программа на этом компьютере)
export interface AgentInfo {
  agent: string;
  version: string;
  platform?: string;
  autostart: boolean;
}

const agentUrl = (path: string) => new URL(path, new URL(import.meta.env.BASE_URL, location.href));
let agentPromise: Promise<AgentInfo | null> | null = null;

/** Сведения об агенте; null – страница открыта не через агента. */
export function agentInfo(): Promise<AgentInfo | null> {
  agentPromise ??= (async () => {
    if (hasIpc()) return null;
    try {
      const r = await fetch(agentUrl("api/agent"), { cache: "no-store" });
      if (!r.ok) return null;
      const j = (await r.json()) as AgentInfo;
      return j.agent === "mantis" ? j : null;
    } catch {
      return null;
    }
  })();
  return agentPromise;
}

export async function agentAutostart(on: boolean): Promise<boolean> {
  const r = await fetch(agentUrl("api/agent/autostart"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: on }),
  });
  const j = (await r.json()) as { autostart?: boolean; error?: string };
  if (!r.ok) throw new Error(j.error ?? "не получилось");
  return !!j.autostart;
}

export async function agentQuit(): Promise<void> {
  await fetch(agentUrl("api/agent/quit"), { method: "POST" }).catch(() => undefined);
}

export async function setAutostart(on: boolean): Promise<boolean | null> {
  return call<boolean>("set_autostart", { on });
}

export async function quitApp(): Promise<void> {
  await call("quit_app");
}

/** Оболочка спрашивает перед закрытием окна: идёт ли подсчёт (тогда окно прячется в трей). */
export function reportPilotRunning(running: boolean): void {
  void call("pilot_state", { running });
}
