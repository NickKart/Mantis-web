// Общие кусочки интерфейса: подписка на ядро, переходы, окна, переключатели, полоски.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { core } from "./core";
import { IcClose } from "./icons";

/** Перерисовывать компонент при изменениях в ядре (не чаще раза в кадр). */
export function useCore(): typeof core {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => core.subscribe(force), []);
  return core;
}

/** Перерисовывать раз в ms (часы, «синхр. N с назад»). */
export function useTick(ms: number): number {
  const [n, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

// ---------------------------------------------------------------- переходы (#/экран/параметр)
export type Screen = "start" | "live" | "setup" | "analytics" | "compare" | "records";
const SCREENS: Screen[] = ["start", "live", "setup", "analytics", "compare", "records"];

export function parseRoute(): { screen: Screen; param: string } {
  const m = location.hash.match(/^#\/([\w-]+)(?:\/(.*))?/);
  const s = (m?.[1] ?? "") as Screen;
  return { screen: SCREENS.includes(s) ? s : "start", param: decodeURIComponent(m?.[2] ?? "") };
}

export function go(screen: Screen, param = ""): void {
  const h = `#/${screen}${param ? `/${encodeURIComponent(param)}` : ""}`;
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = h;
}

export function useRoute(): { screen: Screen; param: string } {
  const [r, set] = useState(parseRoute);
  useEffect(() => {
    const on = () => set(parseRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

// ---------------------------------------------------------------- окна
export function Modal(p: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; class?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [p.onClose]);
  return (
    <div class="modal-back" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class={`modal ${p.wide ? "wide" : ""} ${p.class ?? ""}`} role="dialog" aria-modal="true" aria-label={p.title}>
        <div class="modal-head">
          <h2>{p.title}</h2>
          <button class="btn icon ghost" aria-label="Закрыть" onClick={p.onClose}><IcClose /></button>
        </div>
        {p.children}
      </div>
    </div>
  );
}

/** Окно «Вы уверены?». Возвращает Promise<boolean>. */
let askHost: ((o: AskOptions | null) => void) | null = null;
interface AskOptions {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
export function ask(o: Omit<AskOptions, "resolve">): Promise<boolean> {
  return new Promise((resolve) => (askHost ? askHost({ ...o, resolve }) : resolve(window.confirm(o.text))));
}
export function AskHost() {
  const [o, set] = useState<AskOptions | null>(null);
  useEffect(() => {
    askHost = set;
    return () => (askHost = null);
  }, []);
  if (!o) return null;
  const done = (v: boolean) => {
    o.resolve(v);
    set(null);
  };
  return (
    <Modal title={o.title} onClose={() => done(false)}>
      <p class="lead">{o.text}</p>
      <div class="modal-actions">
        <button class="btn lg" onClick={() => done(false)}>Отмена</button>
        <button class={`btn lg ${o.danger ? "danger" : "primary"}`} onClick={() => done(true)} autoFocus>{o.ok}</button>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const c = useCore();
  return (
    <div class="toast-box" aria-live="polite">
      {c.toasts.map((t) => <div key={t.id} class={`toast ${t.error ? "error" : ""}`}>{t.text}</div>)}
    </div>
  );
}

// ---------------------------------------------------------------- элементы
export function Seg<T extends string | number>(p: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={p.label}>
      {p.options.map(([v, t]) => (
        <button key={String(v)} type="button" aria-pressed={v === p.value} onClick={() => p.onChange(v)}>{t}</button>
      ))}
    </div>
  );
}

export function Switch(p: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" class="switch" role="switch" aria-checked={p.on} aria-label={p.label} disabled={p.disabled} onClick={() => p.onChange(!p.on)}>
      <span />
    </button>
  );
}

export function Bar(p: { value: number; color: string; thin?: boolean }) {
  const w = `${Math.max(0, Math.min(100, p.value * 100)).toFixed(1)}%`;
  return <span class={`bar ${p.thin ? "thin" : ""}`}><i style={{ width: w, background: p.color }} /></span>;
}

/** Холст, который подстраивается под размер на экране и перерисовывается функцией draw. */
export function useCanvasSize(ref: { current: HTMLElement | null }, onResize: () => void): void {
  const cb = useRef(onResize);
  cb.current = onResize;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => cb.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
}

export const stop = (e: Event) => e.stopPropagation();
export type Child = ComponentChildren;
export type Style = JSX.CSSProperties;
