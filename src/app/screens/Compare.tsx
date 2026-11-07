// Дополнительная аналитика – A/B: две сохранённые записи или два периода (оформления витрины). Вывод, проверка корректности, таблица.
import { abTrack } from "../../../ab/client";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { HourStat } from "../../pilot/hours";
import { type RecordingMeta, listRecordings } from "../../twin/store";
import { type SavedComparison, type Showcase } from "../core";
import { addDays, dayKey, deltaPp, mmss, num, parseDay, pct, rangeLabel, ratio, startOfDay } from "../format";
import { IcAlert, IcCheck, IcChevronDown, IcChevronUp, IcTrash } from "../icons";
import { metaTotals } from "../recs";
import { rowsIn, showcaseRange, sum } from "../stats";
import { Modal, Seg, go, useCore } from "../ui";
import { bold } from "./Analytics";
import { recCams, recWhen } from "./Records";

type Mode = "rec" | "period";
interface Side {
  key: string;
  title: string;
  sub: string;
}
interface PeriodOpt extends Side {
  from: Date;
  to: Date;
}
interface Measure {
  passed: number;
  slowed: number;
  looked: number;
  returned: number;
  entered: number;
  /** Длительность: секунды записи или часы наблюдения периода (в секундах). */
  seconds: number;
}

const TONE = { up: "delta up", down: "delta down", flat: "delta flat" } as const;

function periodOptions(showcases: Showcase[]): PeriodOpt[] {
  const today = startOfDay(new Date());
  const opts: PeriodOpt[] = [];
  const sc = [...showcases].sort((a, b) => b.from.localeCompare(a.from));
  for (const s of sc) {
    const r = showcaseRange(showcases, s);
    const last = addDays(r.to, -1);
    const days = Math.round((r.to.getTime() - r.from.getTime()) / 86_400_000);
    opts.push({ key: `sc:${s.id}`, title: `Витрина «${s.name}»`, sub: `${rangeLabel(r.from, last)} · ${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"}`, from: r.from, to: r.to });
  }
  const span = (key: string, title: string, from: Date, to: Date) => opts.push({ key, title, sub: rangeLabel(from, addDays(to, -1)), from, to });
  span("p:7", "Последние 7 дней", addDays(today, -6), addDays(today, 1));
  span("p:7prev", "Предыдущие 7 дней", addDays(today, -13), addDays(today, -6));
  span("p:30", "Последние 30 дней", addDays(today, -29), addDays(today, 1));
  span("p:30prev", "Предыдущие 30 дней", addDays(today, -59), addDays(today, -29));
  return opts;
}

/** «c:2026-10-01:2026-10-14» – свой период. */
function customOpt(key: string): PeriodOpt | null {
  const m = /^c:(\d{4}-\d\d-\d\d):(\d{4}-\d\d-\d\d)$/.exec(key);
  if (!m) return null;
  const from = parseDay(m[1]), to = addDays(parseDay(m[2]), 1);
  return { key, title: "Свой период", sub: rangeLabel(from, addDays(to, -1)), from, to };
}

export function Compare(p: { param: string }) {
  const c = useCore();
  const saved = c.settings.comparisons.find((x) => x.id === p.param);
  const [mode, setMode] = useState<Mode>(saved?.mode ?? (p.param === "period" ? "period" : "rec"));
  const [recs, setRecs] = useState<RecordingMeta[] | null>(null);
  const [a, setA] = useState<string>(saved?.a ?? "");
  const [b, setB] = useState<string>(saved?.b ?? "");
  const [open, setOpen] = useState<"a" | "b" | null>(null);
  const [customFor, setCustomFor] = useState<"a" | "b" | null>(null);
  useEffect(() => void listRecordings().then(setRecs), []);
  useEffect(() => {
    if (saved) {
      setMode(saved.mode);
      setA(saved.a);
      setB(saved.b);
    }
  }, [p.param]);

  const popts = useMemo(() => periodOptions(c.settings.showcases), [c.settings.showcases]);
  // значения по умолчанию
  useEffect(() => {
    if (mode === "rec" && recs && (!recs.some((r) => r.id === a) || !recs.some((r) => r.id === b))) {
      setA(recs[1]?.id ?? recs[0]?.id ?? "");
      setB(recs[0]?.id ?? "");
    }
    if (mode === "period" && (!findPeriod(a) || !findPeriod(b))) {
      const sc = popts.filter((o) => o.key.startsWith("sc:"));
      if (sc.length >= 2) {
        setA(sc[1].key);
        setB(sc[0].key);
      } else {
        setA("p:7prev");
        setB("p:7");
      }
    }
  }, [mode, recs, popts]);

  function findPeriod(k: string): PeriodOpt | null {
    return popts.find((o) => o.key === k) ?? customOpt(k);
  }

  // ---------------------------------------------------------------- данные сторон
  let sideA: Side | null = null, sideB: Side | null = null, mA: Measure | null = null, mB: Measure | null = null;
  if (mode === "rec") {
    const ra = recs?.find((r) => r.id === a), rb = recs?.find((r) => r.id === b);
    const side = (r: RecordingMeta): Side => ({ key: r.id, title: r.name, sub: `${recWhen(r)} · ${mmss(r.duration)} · ${r.source === "video" ? "видео" : `камера ${recCams(r)}`}` });
    const meas = (r: RecordingMeta): Measure => ({ ...metaTotals(r), seconds: r.duration });
    if (ra) [sideA, mA] = [side(ra), meas(ra)];
    if (rb) [sideB, mB] = [side(rb), meas(rb)];
  } else {
    const pa = findPeriod(a), pb = findPeriod(b);
    const meas = (o: PeriodOpt): Measure => {
      const h: HourStat = sum(rowsIn(c.account.hours.hours, o.from, o.to));
      return { passed: h.people, slowed: h.slowed, looked: h.looked, returned: h.returned, entered: h.entered, seconds: h.seconds };
    };
    if (pa) [sideA, mA] = [{ ...pa, sub: `${pa.sub}` }, meas(pa)];
    if (pb) [sideB, mB] = [{ ...pb, sub: `${pb.sub}` }, meas(pb)];
    if (pa && mA) sideA = { ...sideA!, sub: `${pa.sub} · ${num(mA.seconds / 3600)} ч наблюдения` };
    if (pb && mB) sideB = { ...sideB!, sub: `${pb.sub} · ${num(mB.seconds / 3600)} ч наблюдения` };
  }

  const ready = !!(mA && mB && sideA && sideB);
  const flowUnit = mode === "rec" ? 60 : 3600;
  const flowWord = mode === "rec" ? "в мин" : "в час";
  const flow = (m: Measure) => (m.seconds > 0 ? (m.passed / m.seconds) * flowUnit : 0);
  const sh = (m: Measure) => ({ slow: ratio(m.slowed, m.passed), look: ratio(m.looked, m.slowed), ret: ratio(m.returned, m.passed), enter: ratio(m.entered, m.passed), enterLook: ratio(m.entered, m.looked) });

  let rows: { label: string; base: string; a: string; b: string; aN: string; bN: string; d: string; tone: keyof typeof TONE; wA: number; wB: number }[] = [];
  let verdict = { title: "", text: "" };
  let checks: { ok: boolean; text: string }[] = [];
  if (ready) {
    const A = mA!, B = mB!;
    const sa = sh(A), sb = sh(B);
    const fa = flow(A), fb = flow(B);
    const flowD = fa > 0 ? ((fb - fa) / fa) * 100 : 0;
    const row = (label: string, base: string, va: number, vb: number, na: string, nb: string) => {
      const d = deltaPp(vb, va);
      const mx = Math.max(va, vb) || 1;
      return { label, base, a: pct(va * 100, 100), b: pct(vb * 100, 100), aN: na, bN: nb, d: d.text, tone: d.tone, wA: va / mx, wB: vb / mx };
    };
    const fr = Math.round(flowD);
    rows = [
      {
        label: "Прошли мимо", base: mode === "rec" ? "весь поток за запись" : "весь поток за период", a: num(A.passed), b: num(B.passed),
        aN: `${num(fa)} ${flowWord}`, bN: `${num(fb)} ${flowWord}`, d: fa > 0 ? `${fr > 0 ? "+" : fr < 0 ? "−" : ""}${Math.abs(fr)}% ${flowWord}` : "–",
        tone: Math.abs(flowD) < 5 ? "flat" : flowD > 0 ? "up" : "down", wA: fa / (Math.max(fa, fb) || 1), wB: fb / (Math.max(fa, fb) || 1),
      },
      row("Заинтересовались", "от прошедших", sa.slow, sb.slow, num(A.slowed), num(B.slowed)),
      row("Посмотрели", "от заинтересовавшихся", sa.look, sb.look, num(A.looked), num(B.looked)),
      row("Вернулись", "от прошедших", sa.ret, sb.ret, num(A.returned), num(B.returned)),
      row("Зашли", "от прошедших", sa.enter, sb.enter, num(A.entered), num(B.entered)),
      row("Зашли", "от посмотревших", sa.enterLook, sb.enterLook, num(A.entered), num(B.entered)),
    ];
    const dS = (sb.slow - sa.slow) * 100, dL = (sb.look - sa.look) * 100, dE = (sb.enter - sa.enter) * 100;
    const score = dS + dL;
    const more = (x: number) => `${x >= 0 ? "больше" : "меньше"} на ${Math.abs(x).toFixed(1).replace(".", ",")} п.п.`;
    const q = (t: string) => (t.includes("«") ? t : `«${t}»`);
    let title = "Разница во внимании к витрине небольшая";
    if (score > 2) title = `${q(sideB!.title)} работает лучше: витрину чаще замечают и разглядывают`;
    if (score < -2) title = `${q(sideA!.title)} работает лучше: в ${q(sideB!.title).replace(/^Витрина /, "витрине ")} витрину замечают реже`;
    const enterText = Math.abs(dE) < 0.05 ? "доля зашедших не изменилась" : `доля зашедших ${dE > 0 ? "выросла" : "снизилась"} на ${Math.abs(dE).toFixed(1).replace(".", ",")} п.п.`;
    let text = `В ${mode === "rec" ? "записи" : "периоде"} B заинтересовавшихся ${more(dS)}, посмотревших – ${more(dL)}, а ${enterText}.`;
    if (dE < -0.5 && score > 0) text += " Витрина привлекает, а вход не дожимает – стоит проверить дверь и вывеску.";
    if (dE > 0.5 && score < 0) text += " Заходят чаще, хотя витрину замечают реже – возможно, сработал вход или акция у двери.";
    verdict = { title, text };
    const minN = mode === "rec" ? 30 : 1000;
    const okFlow = Math.abs(flowD) < 15, okSize = Math.min(A.passed, B.passed) >= minN;
    let second: { ok: boolean; text: string };
    if (mode === "rec") second = { ok: true, text: Math.abs(A.seconds - B.seconds) < 2 ? "Одинаковая длительность записей" : "Разная длительность – сравниваем доли, а не штуки" };
    else {
      const pa = findPeriod(a)!, pb = findPeriod(b)!;
      const da = Math.round((pa.to.getTime() - pa.from.getTime()) / 86_400_000), db = Math.round((pb.to.getTime() - pb.from.getTime()) / 86_400_000);
      const sameDays = da === db && da % 7 === 0;
      second = { ok: sameDays, text: sameDays ? "Одинаковые дни недели" : "Разный набор дней недели – будни и выходные могут исказить сравнение" };
    }
    checks = [
      { ok: okFlow, text: okFlow ? `Поток почти равный: ${fr > 0 ? "+" : fr < 0 ? "−" : ""}${Math.abs(fr)}% ${flowWord}` : `Поток отличается на ${Math.abs(fr)}% – выводы осторожнее` },
      second,
      { ok: okSize, text: okSize ? `Больше ${num(minN)} человек в каждой ${mode === "rec" ? "записи" : "части"}` : `Мало людей – нужно хотя бы ${num(minN)} в каждой ${mode === "rec" ? "записи" : "части"}` },
    ];
  }
  const qq = (t: string) => (t.includes("«") ? t : `«${t}»`);
  const subtitle = ready ? `Сравниваем ${mode === "rec" ? "записи" : "периоды"}: ${qq(sideA!.title)} → ${qq(sideB!.title)}` : "";

  const saveCmp = () => {
    if (!ready) return;
    const item: SavedComparison = { id: `cmp-${Date.now().toString(36)}`, mode, a, b, title: `${sideA!.title} → ${sideB!.title}`, at: Date.now() };
    c.updateSettings({ comparisons: [item, ...c.settings.comparisons].slice(0, 20) });
    c.toast("Сравнение сохранено");
  };

  const options = (side: "a" | "b"): (Side & { disabled: boolean; note: string })[] => {
    const cur = side === "a" ? a : b, other = side === "a" ? b : a;
    const list: Side[] = mode === "rec"
      ? (recs ?? []).map((r) => ({ key: r.id, title: r.name, sub: `${recWhen(r)} · ${mmss(r.duration)} · ${metaTotals(r).passed} прошли` }))
      : popts;
    return list.map((o) => ({ ...o, disabled: o.key === other, note: o.key === cur ? "выбрана" : o.key === other ? `уже ${side === "a" ? "B" : "A"}` : "" }));
  };

  const noRecs = mode === "rec" && recs && recs.length < 2;
  return (
    <main class="main compare">
      <header class="page-head">
        <div class="titles">
          <h1>Дополнительная аналитика</h1>
          <h2 class="h-sub" style={{ marginTop: "6px" }}>A/B тестирование</h2>
          <p class="lead">Сравнивает две сохранённые записи, два периода или два варианта оформления и показывает, где витрина сработала лучше. Нужна, чтобы оценить смену витрины, провести A/B-тест выкладки или выбрать помещение.</p>
          <span class="sub">{subtitle}</span>
        </div>
        <div class="no-print"><Seg label="Что сравниваем" value={mode} options={[["rec", "Сохранённые записи"], ["period", "Периоды"]]} onChange={(m) => { setMode(m); setOpen(null); go("compare", m); }} /></div>
        <button class="btn no-print" disabled={!ready} onClick={saveCmp}>Сохранить</button>
        <button class="btn primary no-print" disabled={!ready} onClick={() => { abTrack("report_exported", { screen: "compare" }); window.print(); }}>Отчёт для клиента</button>
      </header>
      <div class="print-only print-title"><b>Mantis · A/B-сравнение витрины</b><span>{subtitle} · {new Date().toLocaleDateString("ru-RU")}</span></div>

      {c.settings.comparisons.length > 0 && (
        <div class="saved-cmp no-print">
          <span class="small muted">Сохранённые:</span>
          {c.settings.comparisons.slice(0, 6).map((s) => (
            <span key={s.id} class="saved-chip">
              <a href={`#/compare/${s.id}`}>{s.title}</a>
              <button aria-label="Удалить сравнение" onClick={() => c.updateSettings({ comparisons: c.settings.comparisons.filter((x) => x.id !== s.id) })}><IcTrash size={12} /></button>
            </span>
          ))}
        </div>
      )}

      {noRecs ? (
        <section class="card empty-card">
          <h2>Нужны хотя бы две записи</h2>
          <p class="lead">Запишите два фрагмента на экране Live – например, до и после смены витрины, или утро и вечер. Или сравните периоды по статистике.</p>
          <div class="dl-row">
            <button class="btn primary lg" onClick={() => go("live")}>Открыть Live</button>
            <button class="btn lg" onClick={() => { setMode("period"); go("compare", "period"); }}>Сравнить периоды</button>
          </div>
        </section>
      ) : (
        <>
          <div class="pickers-wrap">
            <div class="pickers">
              {(["a", "b"] as const).map((side) => {
                const s = side === "a" ? sideA : sideB;
                const isOpen = open === side;
                return (
                  <Picker key={side} side={side} s={s} open={isOpen} onToggle={() => setOpen(isOpen ? null : side)} onClose={() => setOpen(null)}>
                    <span class="pk-group">{mode === "rec" ? "Сохранённые записи" : "Оформления и периоды"}</span>
                    {options(side).map((o) => (
                      <button key={o.key} class="pk-opt" disabled={o.disabled} aria-current={o.note === "выбрана"} onClick={() => { (side === "a" ? setA : setB)(o.key); setOpen(null); }}>
                        <span><b>{o.title}</b><span>{o.sub}</span></span>
                        <span class="pk-note">{o.note}</span>
                      </button>
                    ))}
                    {mode === "rec"
                      ? <a class="pk-link" href="#/records">Открыть раздел «Записи»</a>
                      : (
                        <div class="pk-actions">
                          <button class="btn" onClick={() => { setOpen(null); setCustomFor(side); }}>Свой период…</button>
                          <a class="pk-link" href="#" onClick={(e) => { e.preventDefault(); setOpen(null); go("analytics"); }}>Оформления витрины – в «Аналитике»</a>
                        </div>
                      )}
                  </Picker>
                );
              })}
            </div>
            <span class="sub">{mode === "rec"
              ? "Нажмите на запись A или B, чтобы выбрать другую из раздела «Записи». Сравниваются доли, поэтому записи могут быть разной длины."
              : "Сравниваются два периода работы камеры. Лучше всего – одинаковые дни недели и часы, например две недели с разными витринами."}</span>
          </div>

          {ready && (
            <>
              <section class="card verdict" aria-labelledby="verdict-h">
                <div class="verdict-main">
                  <span class="verdict-eyebrow">Вывод</span>
                  <h2 id="verdict-h">{verdict.title}</h2>
                  <p>{bold(verdict.text)}</p>
                </div>
                <div class="verdict-checks">
                  <span>{checks.every((x) => x.ok) ? "Сравнение корректно" : "Проверьте сравнение"}</span>
                  {checks.map((x) => (
                    <span key={x.text} class="vc-row">
                      {x.ok ? <IcCheck size={16} color="#15803D" width={2.4} /> : <IcAlert size={16} color="#C2410C" width={2.2} />}
                      <span>{x.text}</span>
                    </span>
                  ))}
                </div>
              </section>

              <section class="card cmp-table" aria-labelledby="tbl-h">
                <h2 id="tbl-h">Показатели</h2>
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead>
                      <tr><th scope="col">Показатель</th><th scope="col" class="num">A</th><th scope="col" class="num">B</th><th scope="col" class="num">Изменение</th><th scope="col" class="bars">A / B</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.label + r.base}>
                          <th scope="row"><span class="cell2"><span>{r.label}</span><small>{r.base}</small></span></th>
                          <td class="num"><span class="cell2"><b>{r.a}</b><small>{r.aN}</small></span></td>
                          <td class="num"><span class="cell2"><b>{r.b}</b><small>{r.bN}</small></span></td>
                          <td class="num"><span class={TONE[r.tone]} style={{ fontSize: "13px", padding: "3px 8px" }}>{r.d}</span></td>
                          <td class="bars">
                            <div class="ab-bars">
                              <div style={{ width: `${(r.wA * 100).toFixed(0)}%`, background: "#CAD2DE" }} />
                              <div style={{ width: `${(r.wB * 100).toFixed(0)}%`, background: "#4A9BD8" }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
      {customFor && (
        <CustomPeriod onClose={() => setCustomFor(null)} onPick={(from, to) => {
          (customFor === "a" ? setA : setB)(`c:${from}:${to}`);
          setCustomFor(null);
        }} />
      )}
    </main>
  );
}

function Picker(p: { side: "a" | "b"; s: Side | null; open: boolean; onToggle: () => void; onClose: () => void; children: preact.ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && p.onClose();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [p.open]);
  const L = p.side.toUpperCase();
  return (
    <div class="picker" ref={ref}>
      <button class={`pk-btn ${p.open ? "open" : ""}`} aria-expanded={p.open} aria-label={`${L}: ${p.s?.title ?? "не выбрано"}. Выбрать другое`} onClick={p.onToggle}>
        <span class={`pk-letter ${p.side}`}>{L}</span>
        <span class="pk-text"><b>{p.s?.title ?? "Выберите"}</b><span>{p.s?.sub ?? ""}</span></span>
        {p.open ? <IcChevronUp size={16} color="#5E6A7D" width={2} /> : <IcChevronDown size={16} color="#5E6A7D" width={2} />}
      </button>
      {p.open && <div class="pk-menu">{p.children}</div>}
    </div>
  );
}

function CustomPeriod(p: { onClose: () => void; onPick: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(dayKey(addDays(new Date(), -13)));
  const [to, setTo] = useState(dayKey(addDays(new Date(), -7)));
  return (
    <Modal title="Свой период" onClose={p.onClose}>
      <div class="form-grid">
        <div class="field"><label for="cp-from">С</label><input id="cp-from" class="input" type="date" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} /></div>
        <div class="field"><label for="cp-to">По</label><input id="cp-to" class="input" type="date" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} /></div>
      </div>
      <div class="modal-actions">
        <button class="btn lg" onClick={p.onClose}>Отмена</button>
        <button class="btn lg primary" disabled={!from || !to} onClick={() => p.onPick(from <= to ? from : to, from <= to ? to : from)}>Выбрать</button>
      </div>
    </Modal>
  );
}
