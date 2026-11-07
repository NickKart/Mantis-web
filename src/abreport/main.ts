// Отчёт A/B-теста веб-версии (mantis.rcmit.ru/ab.html): вход администратора и таблица по вариантам из /api/ab/report.
// Доступ – почты из AB_ADMINS на сервере (docs/ab-test.md).
import "@fontsource-variable/inter/index.css";
import type { AbReport, VariantStats } from "../../server/ab";
import { friendlyError, idToken, signIn, signOut, watchAuth } from "../cloud/firebase";

const root = document.getElementById("ab")!;

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: 14px/1.5 "Inter Variable", system-ui, sans-serif; color: #1F2937; background: #F8FAFC; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #6B7280; }
  .card { background: #fff; border: 1px solid #E5E7EB; border-radius: 14px; padding: 20px; margin-top: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 9px 8px; border-bottom: 1px solid #F1F5F9; text-align: right; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  th { font-weight: 600; color: #374151; }
  .prob { display: flex; gap: 12px; flex-wrap: wrap; }
  .prob div { flex: 1 1 180px; border-radius: 12px; padding: 14px; background: #F1F5F9; }
  .prob b { display: block; font-size: 24px; }
  input { display: block; width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #D1D5DB; border-radius: 10px; margin: 6px 0 12px; font: inherit; }
  button { font: inherit; padding: 9px 16px; border-radius: 10px; border: 1px solid #D1D5DB; background: #fff; cursor: pointer; }
  button.primary { background: #4A9BD8; border-color: #4A9BD8; color: #fff; }
  .error { color: #B91C1C; }
  .row { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
`;
document.head.append(style);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (x: number, n: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : "–");
const prob = (p: number | null) => (p == null ? "мало данных" : `${Math.round(p * 100)}%`);
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "–");

function loginForm(error?: string): void {
  root.innerHTML = `
    <h1>A/B-тест веб-версии</h1>
    <p class="muted">Войдите аккаунтом администратора Mantis.</p>
    <div class="card">
      <label>Почта<input id="email" type="email" autocomplete="email" /></label>
      <label>Пароль<input id="pass" type="password" autocomplete="current-password" /></label>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <button class="primary" id="go">Войти</button>
    </div>`;
  const go = async () => {
    try {
      await signIn((document.getElementById("email") as HTMLInputElement).value, (document.getElementById("pass") as HTMLInputElement).value);
    } catch (e) {
      loginForm(friendlyError(e));
    }
  };
  document.getElementById("go")!.onclick = go;
  document.getElementById("pass")!.onkeydown = (e) => e.key === "Enter" && void go();
}

function rows(r: AbReport): string {
  const { a, b } = r.variants;
  const d = r.config.activationDays;
  const line = (label: string, f: (s: VariantStats) => string) => `<tr><td>${label}</td><td>${f(a)}</td><td>${f(b)}</td></tr>`;
  return [
    line("Посетители", (s) => String(s.visitors)),
    line("Аккаунты", (s) => String(s.accounts)),
    line("Регистрации (от посетителей)", (s) => `${s.signups} · ${pct(s.signups, s.visitors)}`),
    line(`Аккаунтов старше ${d} дн.`, (s) => String(s.matured)),
    line(`<b>Активация за ${d} дн.</b>`, (s) => `<b>${s.activated} · ${pct(s.activated, s.matured)}</b>`),
    line(`Вернулись через ${d}+ дн.`, (s) => `${s.returned} · ${pct(s.returned, s.matured)}`),
    line("Подсчёт шёл хоть раз", (s) => String(s.countedEver)),
    line("Пробный период", (s) => String(s.trials)),
    line("Оплатили", (s) => `${s.paid} · ${pct(s.paid, s.accounts)}`),
    line("Выручка, ₽", (s) => s.revenue.toLocaleString("ru-RU")),
  ].join("");
}

async function show(): Promise<void> {
  root.innerHTML = `<p class="muted">Загружаю отчёт…</p>`;
  try {
    const r = await fetch("/api/ab/report", { headers: { Authorization: `Bearer ${await idToken()}` } });
    const data = (await r.json().catch(() => ({}))) as AbReport & { error?: string };
    if (!r.ok) throw new Error(data.error ?? `Сервер ответил ${r.status}`);
    const split = Math.round(data.config.splitB * 100);
    root.innerHTML = `
      <div class="row">
        <div>
          <h1>A/B-тест веб-версии</h1>
          <p class="muted">${data.running ? "Идёт" : "Остановлен"} · данные с ${date(data.since)} · доля B ${split}% · «${esc(data.experiment)}»</p>
        </div>
        <div><button id="refresh">Обновить</button> <button id="out">Выйти</button></div>
      </div>
      <div class="card">
        <table>
          <thead><tr><th></th><th>A – новая</th><th>B – старая</th></tr></thead>
          <tbody>${rows(data)}</tbody>
        </table>
      </div>
      <div class="card">
        <p class="muted" style="margin-top:0">Вероятность, что новая версия лучше старой</p>
        <div class="prob">
          <div><b>${prob(data.pABetter.activation)}</b>по активации</div>
          <div><b>${prob(data.pABetter.signup)}</b>по регистрации</div>
          <div><b>${prob(data.pABetter.paid)}</b>по оплате</div>
        </div>
        <p class="muted">Решение можно принимать, когда вероятность устойчиво выше 95% или ниже 5% и в каждом варианте не меньше нескольких десятков аккаунтов старше ${data.config.activationDays} дней. Аккаунты команды (?ab=, AB_EXCLUDE) не считаются.</p>
      </div>`;
    document.getElementById("refresh")!.onclick = () => void show();
    document.getElementById("out")!.onclick = () => void signOut();
  } catch (e) {
    root.innerHTML = `<h1>A/B-тест веб-версии</h1><div class="card"><p class="error">${esc((e as Error).message)}</p><button id="out">Выйти</button></div>`;
    document.getElementById("out")!.onclick = () => void signOut();
  }
}

watchAuth((user) => (user ? void show() : loginForm()));
