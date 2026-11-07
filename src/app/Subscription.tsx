// Профиль → подписка: состояние счёта, выбор тарифа и камер, оплата через ЮKassa, пробный период, история.
import { useEffect, useState } from "preact/hooks";
import {
  MAX_CAMERAS, PLAN_IDS, type Period, type PlanId, TARIFFS, TRIAL_DAYS, paymentAmount, planForCameras, plural, rangeText, rub,
} from "../../api/_lib/tariffs";
import { type BillingStatus, type ReturnKind, billing } from "./billing";
import { abTrack } from "../../ab/client";
import { Switch } from "./switch";

const dateText = (ms: number) => new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const cams = (n: number) => `${n} ${plural(n, "камера", "камеры", "камер")}`;

/** toast – всплывающее сообщение (в новом интерфейсе – core.toast, в старой версии – свой). */
export function Subscription(p: { returned?: ReturnKind | null; toast: (text: string, error?: boolean) => void }) {
  const c = { toast: p.toast };
  const [st, setSt] = useState<BillingStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameras, setCameras] = useState(1);
  const [period, setPeriod] = useState<Period>("month");
  const [saveCard, setSaveCard] = useState(true);
  const plan = planForCameras(cameras);
  const t = TARIFFS[plan];

  const load = async () => {
    try {
      const s = await billing.status();
      setSt(s);
      setLoadErr(null);
      return s;
    } catch (e) {
      setLoadErr((e as Error).message);
      return null;
    }
  };

  useEffect(() => {
    abTrack("subscription_open", { returned: p.returned ?? null });
    let alive = true;
    void (async () => {
      const s = await load();
      if (s?.account.plan) {
        setCameras(s.account.cameras);
        if (s.account.annualUntil && s.account.annualUntil > s.now && TARIFFS[s.account.plan].year) setPeriod("year");
      }
      // вернулись с ЮKassa: она может сообщить об оплате или привязке карты с задержкой – проверяем ещё несколько раз
      if (p.returned && alive) {
        const was = s?.ledger.find((x) => x.type === "topup")?.at ?? 0;
        const done = (n: BillingStatus | null) => p.returned === "card"
          ? !!n?.account.card
          : (n?.ledger.find((x) => x.type === "topup")?.at ?? 0) > was;
        if (p.returned === "card" && done(s)) c.toast(s!.account.status === "trial" ? "Карта привязана, пробный период начался" : "Карта привязана");
        for (let i = 0; i < 6 && alive && !done(s); i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const n = await load();
          if (done(n)) {
            c.toast(p.returned === "card" ? (n!.account.status === "trial" ? "Карта привязана, пробный период начался" : "Карта привязана") : "Оплата зачислена");
            break;
          }
        }
      }
    })();
    return () => void (alive = false);
  }, []);

  useEffect(() => {
    if (period === "year" && t.year == null) setPeriod("month");
  }, [plan]);

  const sel = { plan, cameras, period };
  const amount = paymentAmount(sel);
  const acc = st?.account;
  const now = st?.now ?? Date.now();
  const trialOk = !!acc && !acc.trialUsed && t.trial && !(acc.paidUntil && acc.paidUntil > now);
  const autopay = !!st?.autopay;
  const trialNeedsCard = autopay && !acc?.card;
  const monthly = paymentAmount({ plan, cameras, period: "month" });

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pay = () => run(async () => {
    abTrack("payment_start", { kind: "pay", plan, cameras, period });
    const r = await billing.pay(sel, autopay && !acc?.card && saveCard);
    location.href = r.url;
  });
  const trial = () => run(async () => {
    abTrack("payment_start", { kind: "trial", plan, cameras });
    const r = await billing.trial(plan, cameras);
    if (r.url) {
      location.href = r.url;
      return;
    }
    await load();
    c.toast(`Пробный период ${TRIAL_DAYS} дней начался`);
  });
  const bind = () => run(async () => {
    abTrack("payment_start", { kind: "card" });
    location.href = (await billing.bindCard()).url;
  });
  const unbind = () => run(async () => {
    await billing.unbindCard();
    await load();
    c.toast("Карта отвязана");
  });
  const renew = (on: boolean) => run(async () => {
    await billing.autoRenew(on);
    await load();
  });

  const pickPlan = (id: PlanId) => {
    const x = TARIFFS[id];
    if (cameras < x.minCameras || cameras > x.maxCameras) setCameras(x.minCameras);
  };

  return (
    <section class="sub">
      <h3 class="sub-h">Подписка</h3>

      {loadErr && <p class="sub-warn">{loadErr}</p>}
      {!st && !loadErr && <div class="sub-card muted small">Загружаем счёт…</div>}
      {acc && <StatusCard st={st!} onRenew={renew} onBind={bind} onUnbind={unbind} busy={busy} />}

      <div class="plans" role="radiogroup" aria-label="Тариф">
        {PLAN_IDS.map((id) => {
          const x = TARIFFS[id];
          return (
            <button key={id} type="button" role="radio" aria-checked={plan === id} class="plan" onClick={() => pickPlan(id)}>
              <span class="plan-name">{x.name}</span>
              <span class="plan-price">{rub(x.month)}<small> за камеру в месяц</small></span>
              {x.year != null && <span class="plan-year">{rub(x.year)} при оплате за год</span>}
              <span class="plan-range">{rangeText(x)}{x.trial ? ` · ${TRIAL_DAYS} дней бесплатно` : ""}</span>
              <ul>{x.features.map((f) => <li key={f}>{f}</li>)}</ul>
            </button>
          );
        })}
      </div>

      <div class="sub-row">
        <div class="field">
          <span class="label">Камер</span>
          <div class="stepper">
            <button type="button" class="btn icon" aria-label="Меньше камер" disabled={cameras <= 1} onClick={() => setCameras(cameras - 1)}>−</button>
            <input class="input" inputMode="numeric" aria-label="Число камер" value={String(cameras)}
              onInput={(e) => {
                const n = parseInt((e.target as HTMLInputElement).value, 10);
                if (isFinite(n)) setCameras(Math.max(1, Math.min(MAX_CAMERAS, n)));
              }} />
            <button type="button" class="btn icon" aria-label="Больше камер" disabled={cameras >= MAX_CAMERAS} onClick={() => setCameras(cameras + 1)}>+</button>
          </div>
        </div>
        <div class="field">
          <span class="label">Оплата</span>
          <div class="seg">
            <button type="button" aria-pressed={period === "month"} onClick={() => setPeriod("month")}>За месяц</button>
            <button type="button" aria-pressed={period === "year"} disabled={t.year == null} title={t.year == null ? `У тарифа «${t.name}» нет оплаты за год` : undefined}
              onClick={() => setPeriod("year")}>За год{t.year != null ? ` −${Math.round((1 - t.year / t.month) * 100)}%` : ""}</button>
          </div>
        </div>
      </div>

      <div class="sub-total">
        <div>
          <div class="sub-sum">{rub(amount)}</div>
          <div class="small muted">
            «{t.name}»: {rub(period === "year" ? t.year! : t.month)} × {cams(cameras)}{period === "year" ? " × 12 месяцев" : " × 1 месяц"}
          </div>
        </div>
        <span class="sub-actions">
          {trialOk && <button class="btn lg" disabled={busy} onClick={() => void trial()}>{trialNeedsCard ? `${TRIAL_DAYS} дней бесплатно – привязать карту` : `${TRIAL_DAYS} дней бесплатно`}</button>}
          <button class="btn lg solid" disabled={busy || !acc} onClick={() => void pay()}>Оплатить {rub(amount)}</button>
        </span>
      </div>
      {autopay && !acc?.card && (
        <label class="sub-check">
          <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard((e.target as HTMLInputElement).checked)} />
          <span class="small">Сохранить карту и продлевать подписку с неё, если на балансе не хватает</span>
        </label>
      )}
      {trialOk && trialNeedsCard && (
        <p class="sub-consent small">
          {TRIAL_DAYS} дней бесплатно: привяжите карту на странице ЮKassa – сейчас ничего не спишется.
          После окончания пробного периода с карты будет списываться {rub(monthly)} в месяц («{t.name}», {cams(cameras)}),
          пока вы не отключите автопродление или не отвяжете карту в профиле.
        </p>
      )}
      {err && <p class="error-text">{err}</p>}
      <p class="small muted">
        Оплата через ЮKassa: карта, СБП, SberPay. Деньги зачисляются на баланс, подписка продлевается каждый месяц списанием с баланса
        {autopay ? ", а если на балансе не хватает – с сохранённой карты" : ""}. Новый тариф или число камер начнут действовать со следующего списания.
      </p>

      {st && st.ledger.length > 0 && (
        <details class="ledger">
          <summary>История операций</summary>
          <table>
            <tbody>
              {st.ledger.map((x, i) => (
                <tr key={i}>
                  <td class="muted">{new Date(x.at).toLocaleDateString("ru-RU")}</td>
                  <td>{x.note}{x.type === "charge" && x.to ? <span class="muted"> · до {new Date(x.to).toLocaleDateString("ru-RU")}</span> : null}</td>
                  <td class={`num ${x.amount > 0 ? "plus" : x.amount < 0 ? "minus" : ""}`}>{x.amount > 0 ? "+" : ""}{x.amount ? rub(x.amount) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function StatusCard(p: { st: BillingStatus; onRenew: (on: boolean) => void; onBind: () => void; onUnbind: () => void; busy: boolean }) {
  const { account: a, next, now } = p.st;
  const t = a.plan ? TARIFFS[a.plan] : null;
  const live = a.paidUntil != null && a.paidUntil > now;
  const badge = a.status === "trial" && live ? { cls: "trial", text: `Пробный период до ${dateText(a.paidUntil!)}` }
    : live ? { cls: "ok", text: `Оплачено до ${dateText(a.paidUntil!)}` }
      : a.paidUntil ? { cls: "off", text: `Закончилась ${dateText(a.paidUntil)}` }
        : { cls: "none", text: "Не оформлена" };
  return (
    <div class="sub-card">
      <div class="sub-top">
        <div class="sub-plan">
          <b>{t ? `${t.name} · ${cams(a.cameras)}` : "Тариф не выбран"}</b>
          <span class={`badge-${badge.cls}`}>{badge.text}</span>
        </div>
        <div class="sub-balance">
          <span class="small muted">Баланс</span>
          <b>{rub(a.balance)}</b>
        </div>
      </div>
      {t && (
        <div class="sub-next">
          <span class="small">
            {!a.autoRenew ? "Автопродление выключено – после окончания срока подписка остановится."
              : next && next.enough ? `Следующее списание ${dateText(next.at)} – ${rub(next.amount)} с баланса.`
                : next && next.fromCard && a.card && !live
                  ? `Спишем ${rub(next.fromCard)} с карты ${a.card.title} при следующей проверке – попытки идут раз в сутки 3 дня после окончания срока. Можно оплатить вручную.`
                : next && next.fromCard && a.card
                  ? `Следующее списание ${dateText(next.at)} – ${a.balance > 0 ? `${rub(a.balance)} с баланса и ${rub(next.fromCard)} с карты ${a.card.title}` : `${rub(next.amount)} с карты ${a.card.title}`}.`
                  : next ? `${live ? `${dateText(next.at)} нужно ${rub(next.amount)}` : `Для продления нужно ${rub(next.amount)}`} – на балансе не хватает ${rub(next.amount - a.balance)}.`
                    : ""}
            {a.annualUntil && a.annualUntil > now ? ` Годовая цена действует до ${dateText(a.annualUntil)}.` : ""}
          </span>
          <label class="sub-renew">
            <Switch on={a.autoRenew} label="Продлевать автоматически" disabled={p.busy} onChange={p.onRenew} />
            <span class="small">Продлевать автоматически</span>
          </label>
        </div>
      )}
      {a.autopayError && <p class="sub-warn">{a.autopayError}</p>}
      {(a.card || p.st.autopay) && (
        <div class="sub-cardrow">
          {a.card ? (
            <>
              <span class="small"><b>{a.card.title}</b> – {a.autoRenew ? "продлеваем с неё, если на балансе не хватает" : "сохранена, автопродление выключено"}</span>
              <button class="btn ghost" disabled={p.busy} onClick={p.onUnbind}>Отвязать</button>
            </>
          ) : (
            <>
              <span class="small muted">Карта не привязана – продление только с баланса</span>
              <button class="btn" disabled={p.busy} onClick={p.onBind}>Привязать карту</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
