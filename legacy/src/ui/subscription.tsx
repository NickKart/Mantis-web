// Подписка в старой версии (вариант B A/B-теста) – тот же блок, что в профиле новой версии (src/app/Subscription.tsx):
// тарифы, оплата через ЮKassa, пробный период, карта, история. Окно рисуется в Shadow DOM со стилями новой версии,
// чтобы они не смешивались со стилями старой.
import "@fontsource-variable/inter/index.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import appCss from "../../../src/app/app.css?inline";
import screensCss from "../../../src/app/screens.css?inline";
import { type ReturnKind } from "../../../src/app/billing";
import { Subscription } from "../../../src/app/Subscription";

let host: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;

// :root и body новой версии внутри Shadow DOM – это сам хост
const css = (s: string) => s.replace(/:root\b/g, ":host").replace(/(^|[},\s])(html,\s*)?body\b/g, "$1:host");

function SubscriptionDialog(p: { returned: ReturnKind | null; onClose: () => void }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; error: boolean }[]>([]);
  const toast = (text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3500);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <>
      <div class="modal-back" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
        <div class="modal wide" role="dialog" aria-modal="true" aria-label="Подписка">
          <div class="modal-head">
            <h2>Тарифы и оплата</h2>
            <button class="btn icon ghost" aria-label="Закрыть" onClick={p.onClose}>✕</button>
          </div>
          <Subscription returned={p.returned} toast={toast} />
          <div class="modal-actions">
            <button class="btn lg" onClick={p.onClose}>Закрыть</button>
          </div>
        </div>
      </div>
      <div class="toast-box" aria-live="polite">
        {toasts.map((t) => <div key={t.id} class={`toast ${t.error ? "error" : ""}`}>{t.text}</div>)}
      </div>
    </>
  );
}

/** Открыть окно подписки. returned – пользователь вернулся со страницы ЮKassa. */
export function openSubscription(returned: ReturnKind | null = null): void {
  if (!host) {
    host = document.createElement("div");
    host.id = "mantis-subscription";
    host.style.cssText = "position:relative;z-index:2147483000";
    document.body.append(host);
    shadowRoot = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{all:initial;display:block}\n" + css(appCss) + "\n" + css(screensCss);
    shadowRoot.append(style);
  }
  const mount = document.createElement("div");
  shadowRoot!.append(mount);
  const close = () => {
    render(null, mount);
    mount.remove();
  };
  render(<SubscriptionDialog returned={returned} onClose={close} />, mount);
}
