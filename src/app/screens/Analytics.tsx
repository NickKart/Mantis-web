// Аналитика: воронка витрины за период, изменение к прошлому периоду, по часам и дням недели, главное, выручка, касса.
import { abTrack } from "../../../ab/client";
import { useMemo, useState } from "preact/hooks";
import type { Showcase } from "../core";
import { addDays, dayKey, num, parseDay, pct, rub } from "../format";
import { IcAlert, IcClock, IcDownload, IcReturn, IcTrash, IcTrend } from "../icons";
import {
  type Period, daysObserved, deltaOf, demoHours, demoShowcases, funnel, hourBars, insights, periodKey, periodOf, periodTitle,
  prevTitle, previousPeriod, revenue, rowsIn, showcaseAt, showcaseLabel, sum, weekdays,
} from "../stats";
import { Modal, Seg, go, useCore } from "../ui";

const RAMP = ["var(--r1)", "var(--r2)", "var(--r3)", "var(--r4)"];
const PERIOD_KEY = "mantis.analytics.period";

export function Analytics() {
  const c = useCore();
  const [kind, setKind] = useState<Period["kind"]>(() => (localStorage.getItem(PERIOD_KEY) as Period["kind"]) || "7");
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => ({ from: dayKey(addDays(new Date(), -13)), to: dayKey(new Date()) }));
  const [pickPeriod, setPickPeriod] = useState(false);
  const [showcases, setShowcases] = useState(false);
  const [whatReturned, setWhatReturned] = useState(false);
  const [demo, setDemo] = useState(false);
  const [checksDraft, setChecksDraft] = useState<string | null>(null);

  const hasData = Object.values(c.account.hours.hours).some((h) => h.people > 0 || h.seconds > 0);
  const useDemo = demo;
  const hours = useMemo(() => (useDemo ? demoHours() : c.account.hours.hours), [useDemo, c.account.hours.hours, Object.keys(c.account.hours.hours).length]);
  const scList: Showcase[] = useDemo ? demoShowcases() : c.settings.showcases;
  const period = periodOf(kind, custom);
  const prevP = previousPeriod(period);
  const rows = rowsIn(hours, period.from, period.to);
  const total = sum(rows);
  const prevRows = rowsIn(hours, prevP.from, prevP.to);
  const prev = prevRows.length ? sum(prevRows) : null;
  const steps = funnel(total, prev);
  const hb = hourBars(rows);
  const maxH = Math.max(1, ...hb.map((h) => h.passed));
  const peakH = hb.reduce((a, b) => (b.passed > a.passed ? b : a), hb[0]);
  const wd = weekdays(rows);
  const shares = wd.map((w) => w.share).filter((x): x is number => x !== null);
  const [minS, maxS] = [Math.min(...shares), Math.max(...shares)];
  const ins = insights({ rows, total, prev, period, showcases: scList, hours });
  const rev = revenue(total, c.account.state.profile);
  const sc = showcaseAt(scList, addDays(period.to, -1));
  const pKey = periodKey(period);
  const checks = c.settings.checks[pKey];
  const retDelta = prev ? deltaOf(total.returned, total.seconds, prev.returned, prev.seconds) : null;
  const observed = daysObserved(rows);

  const setPeriod = (k: Period["kind"]) => {
    if (k === "custom") return setPickPeriod(true);
    setKind(k);
    try {
      localStorage.setItem(PERIOD_KEY, k);
    } catch {
      /* нет */
    }
  };

  if (!hasData && !demo) {
    return (
      <main class="main">
        <AnalyticsHead period={period} kind={kind} setPeriod={setPeriod} sc={null} onShowcases={() => setShowcases(true)} />
        <section class="card empty-card">
          <h2>Данных пока нет</h2>
          <p class="lead">Аналитика строится из подсчёта: запустите камеру на экране Live – первые доли воронки появятся, когда мимо пройдёт хотя бы 30 человек, картина по часам и дням – через сутки.{c.account.state.user ? "" : " Если подсчёт уже шёл на другом устройстве – войдите в тот же аккаунт."}</p>
          <div class="dl-row">
            <button class="btn primary lg" onClick={() => go(c.pilot.channels.length ? "live" : "setup", c.pilot.channels.length ? "" : "new")}>{c.pilot.channels.length ? "Открыть Live" : "Настроить камеру"}</button>
            <button class="btn lg" onClick={() => setDemo(true)}>Показать на примере</button>
          </div>
        </section>
        {showcases && <ShowcasesModal onClose={() => setShowcases(false)} />}
      </main>
    );
  }

  return (
    <main class="main analytics">
      <AnalyticsHead period={period} kind={kind} setPeriod={setPeriod} sc={sc} onShowcases={() => setShowcases(true)} demo={useDemo} onExitDemo={() => setDemo(false)} />
      <div class="print-only print-title">
        <b>Mantis · отчёт по витрине</b>
        <span>{c.account.state.profile.point || c.account.state.profile.name || ""} · {periodTitle(period)} · {new Date().toLocaleDateString("ru-RU")}</span>
      </div>

      <section class="card" aria-labelledby="funnel-h" style={{ gap: "20px" }}>
        <div class="card-head">
          <h2 id="funnel-h">Воронка витрины</h2>
          <span class="sub">доли – от предыдущего шага · изменение {prevTitle(period)}</span>
          {useDemo && <span class="tag right">демо-данные</span>}
          {!useDemo && observed > 0 && <span class="tag right">{observed} {observed === 1 ? "день" : observed < 5 ? "дня" : "дней"} наблюдения · {num(total.seconds / 3600)} ч</span>}
        </div>
        <div class="funnel">
          {steps.map((s, i) => (
            <div key={s.key} class="funnel-step">
              <div class="fs-top">
                <span>{s.label}</span>
                {s.delta && <span class={`delta ${s.delta.tone}`}>{s.delta.text}</span>}
              </div>
              <span class="fs-value">{num(s.value)}</span>
              <span class="bar"><i style={{ width: `${Math.max(s.value > 0 ? 1.2 : 0, s.width * 100)}%`, background: RAMP[i] }} /></span>
              <span class="fs-rate">{s.rate}</span>
            </div>
          ))}
        </div>
        <div class="returned">
          <IcReturn size={20} color="#C2410C" width={2} />
          <span class="ret-title">Вернулись к витрине – {num(total.returned)}</span>
          <span class="ret-text">{pct(total.returned, total.people)} прохожих прошли мимо, развернулись и вернулись{retDelta ? ` · ${retDelta.text}` : ""}</span>
          <a href="#" class="ret-link no-print" onClick={(e) => { e.preventDefault(); setWhatReturned(!whatReturned); }}>Что это значит</a>
          {whatReturned && (
            <p class="ret-explain">Человек прошёл мимо витрины, отошёл, развернулся и снова подошёл к ней. Это сильный сигнал интереса: витрина «догнала» прохожего. Рост доли вернувшихся после смены оформления – признак, что новая витрина работает.</p>
          )}
        </div>
      </section>

      <div class="row">
        <section class="card grow2" aria-labelledby="hours-h">
          <div class="card-head center">
            <h2 id="hours-h">По часам</h2>
            <span class="sub">в среднем за день</span>
            <span class="right hours-legend">
              <span><i style={{ background: "#DCEEFB" }} />Прошли мимо</span>
              <span><i style={{ background: "#4A9BD8" }} />Посмотрели</span>
            </span>
          </div>
          <div class="hours" style={{ gridTemplateColumns: `repeat(${hb.length}, minmax(0, 1fr))` }}>
            {hb.map((h) => (
              <div key={h.hour} class="hcol" title={`${h.hour}:00 – прошли ${num(h.passed)}, посмотрели ${num(h.looked)} (в среднем за день)`}>
                <span class="peak" style={{ visibility: h === peakH && h.passed > 0 ? "visible" : "hidden" }}>пик</span>
                <div class="hbar" style={{ height: `${Math.round((h.passed / maxH) * 180)}px` }}>
                  <div style={{ height: `${Math.round((h.looked / maxH) * 180)}px` }} />
                </div>
              </div>
            ))}
          </div>
          <div class="hours-labels" style={{ gridTemplateColumns: `repeat(${hb.length}, minmax(0, 1fr))` }}>
            {hb.map((h) => <span key={h.hour}>{h.hour}</span>)}
          </div>
        </section>

        <section class="card grow1" aria-labelledby="ins-h">
          <h2 id="ins-h" style={{ fontSize: "16px", fontWeight: 600 }}>Главное за период</h2>
          <div class="insights">
            {ins.map((x, i) => (
              <div key={i} class="insight">
                <span class={`ins-ic ${x.kind}`}>
                  {x.kind === "up" ? <IcTrend size={16} color="#15803D" width={2} /> : x.kind === "warn" ? <IcAlert size={16} color="#C2410C" width={2} /> : <IcClock size={16} color="#3A4456" width={2} />}
                </span>
                <span>{bold(x.text)}</span>
              </div>
            ))}
            {!ins.length && <span class="empty-note">Выводы появятся, когда наберётся хотя бы 30 прохожих.</span>}
          </div>
          <div class="revenue">
            <span class="s13 muted">Оценка выручки от витрины</span>
            <span class="rev-value">{rev ? `≈ ${rub(rev.value)}` : "–"}</span>
            <span class="small muted" style={{ lineHeight: 1.5 }}>{rev?.text ?? "Нужны посмотревшие или зашедшие"} · <a href="#" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new Event("mantis:profile")); }}>изменить допущения</a></span>
          </div>
        </section>
      </div>

      <div class="row">
        <section class="card grow2" aria-labelledby="days-h" style={{ gap: "14px" }}>
          <div class="card-head center">
            <h2 id="days-h">По дням недели</h2>
            <span class="sub">доля посмотревших</span>
          </div>
          <div class="wdays">
            {wd.map((w) => {
              const t = w.share === null || maxS === minS ? 0.5 : (w.share - minS) / (maxS - minS);
              const bg = w.share === null ? "#F4F6FA" : t > 0.75 ? "#4A9BD8" : t > 0.5 ? "#6DB2E6" : t > 0.25 ? "#A9D3F3" : "#EAF4FC";
              const fg = w.share === null ? "#98A2B3" : t > 0.5 ? "#FFFFFF" : "#14532D";
              return (
                <div key={w.label} title={w.share !== null ? `${w.label}: в среднем ${num(w.people)} прохожих за день` : "нет данных"}>
                  <div class="wd-cell" style={{ background: bg, color: fg }}>{w.share === null ? "–" : `${(w.share * 100).toFixed(1).replace(".", ",")}%`}</div>
                  <span>{w.label}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section class="card grow1" aria-labelledby="pos-h" style={{ gap: "14px" }}>
          <div class="card-head center" style={{ justifyContent: "space-between" }}>
            <h2 id="pos-h">Конверсия в покупку</h2>
            <span class="small muted">из кассы</span>
          </div>
          <div class="checks-row">
            <div class="field" style={{ flex: 1 }}>
              <label for="checks">Чеков за {periodTitle(period) === "сегодня" ? "сегодня" : periodTitle(period)}</label>
              <input id="checks" class="input" inputMode="numeric" value={checksDraft ?? (checks !== undefined ? String(checks) : "")} placeholder="из отчёта кассы"
                onInput={(e) => setChecksDraft((e.target as HTMLInputElement).value)} />
            </div>
            <button class="btn primary" style={{ height: "40px" }} onClick={() => {
              const n = parseInt((checksDraft ?? "").replace(/\D/g, ""), 10);
              const next = { ...c.settings.checks };
              if (isFinite(n)) next[pKey] = n;
              else delete next[pKey];
              c.updateSettings({ checks: next });
              setChecksDraft(null);
            }}>Посчитать</button>
          </div>
          <span class="s14">{checks !== undefined
            ? <>Из зашедших покупают <b>{total.entered ? pct(checks, total.entered) : "–"}</b>, из прохожих – <b>{pct(checks, total.people)}</b>.</>
            : "Введите число чеков из кассы за этот период – Mantis посчитает, какая доля зашедших и прохожих покупает."}</span>
        </section>
      </div>
      {pickPeriod && <PeriodModal value={custom} onClose={() => setPickPeriod(false)} onPick={(v) => { setCustom(v); setKind("custom"); setPickPeriod(false); }} />}
      {showcases && <ShowcasesModal onClose={() => setShowcases(false)} />}
    </main>
  );
}

function AnalyticsHead(p: { period: Period; kind: Period["kind"]; setPeriod: (k: Period["kind"]) => void; sc: Showcase | null; onShowcases: () => void; demo?: boolean; onExitDemo?: () => void }) {
  return (
    <header class="page-head">
      <div class="titles">
        <h1>Аналитика</h1>
        <p class="lead">Показывает, сколько прохожих витрина превращает в посетителей за выбранный период: воронку, пики по часам и дням и главные выводы. С этой вкладки удобно начинать день и готовить отчёт.</p>
        <span class="sub">
          {p.sc ? showcaseLabel(p.sc) : "Оформление витрины не задано"} · <a href="#" class="no-print" onClick={(e) => { e.preventDefault(); p.onShowcases(); }}>{p.sc ? "оформления" : "задать"}</a>
          {p.demo && <> · <a href="#" onClick={(e) => { e.preventDefault(); p.onExitDemo?.(); }}>выйти из примера</a></>}
        </span>
      </div>
      <div class="no-print">
        <Seg label="Период" value={p.kind} onChange={p.setPeriod}
          options={[["today", "Сегодня"], ["7", "7 дней"], ["30", "30 дней"], ["custom", p.kind === "custom" ? periodTitle(p.period) : "Период…"]]} />
      </div>
      <button class="btn no-print" onClick={() => { abTrack("report_exported", { screen: "analytics" }); window.print(); }}><IcDownload size={16} />Отчёт PDF</button>
    </header>
  );
}

/** «**жирный**» → <b>. */
export function bold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
}

function PeriodModal(p: { value: { from: string; to: string }; onClose: () => void; onPick: (v: { from: string; to: string }) => void }) {
  const [v, setV] = useState(p.value);
  return (
    <Modal title="Период" onClose={p.onClose}>
      <div class="form-grid">
        <div class="field"><label for="p-from">С</label><input id="p-from" class="input" type="date" value={v.from} max={dayKey(new Date())} onInput={(e) => setV({ ...v, from: (e.target as HTMLInputElement).value })} /></div>
        <div class="field"><label for="p-to">По</label><input id="p-to" class="input" type="date" value={v.to} max={dayKey(new Date())} onInput={(e) => setV({ ...v, to: (e.target as HTMLInputElement).value })} /></div>
      </div>
      <p class="small muted">Изменение считается к такому же по длине периоду прямо перед выбранным.</p>
      <div class="modal-actions">
        <button class="btn lg" onClick={p.onClose}>Отмена</button>
        <button class="btn lg primary" disabled={!v.from || !v.to} onClick={() => p.onPick(v)}>Показать</button>
      </div>
    </Modal>
  );
}

export function ShowcasesModal(p: { onClose: () => void }) {
  const c = useCore();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(dayKey(new Date()));
  const list = [...c.settings.showcases].sort((a, b) => b.from.localeCompare(a.from));
  const add = () => {
    if (!name.trim()) return;
    c.updateSettings({ showcases: [...c.settings.showcases, { id: `sc-${Date.now().toString(36)}`, name: name.trim(), from }].sort((a, b) => a.from.localeCompare(b.from)) });
    setName("");
  };
  return (
    <Modal title="Оформления витрины" onClose={p.onClose}>
      <p class="lead">Отметьте, когда меняли оформление витрины, – Mantis подпишет периоды, сравнит оформления в «Главном за период» и в A/B-сравнении периодов.</p>
      <div class="sc-list">
        {list.map((s) => (
          <div key={s.id} class="sc-item">
            <span><b>«{s.name}»</b><span class="sub"> · с {parseDay(s.from).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</span></span>
            <button class="btn icon ghost" aria-label="Удалить" onClick={() => c.updateSettings({ showcases: c.settings.showcases.filter((x) => x.id !== s.id) })}><IcTrash size={16} /></button>
          </div>
        ))}
        {!list.length && <span class="empty-note">Пока нет ни одного оформления.</span>}
      </div>
      <div class="form-grid">
        <div class="field"><label for="sc-name">Название</label><input id="sc-name" class="input" placeholder="например, Ноябрь" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && add()} /></div>
        <div class="field"><label for="sc-from">С какого дня</label><input id="sc-from" class="input" type="date" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} /></div>
      </div>
      <div class="modal-actions">
        <button class="btn lg" onClick={p.onClose}>Готово</button>
        <button class="btn lg primary" disabled={!name.trim()} onClick={add}>Добавить</button>
      </div>
    </Modal>
  );
}
