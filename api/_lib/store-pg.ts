// База оплат в PostgreSQL – для своего сервера (прод: mantis.rcmit.ru). Тот же набор функций, что в store.ts (Firestore),
// поэтому обработчики api/* не меняются: сборка сервера (server/build.mjs) подставляет этот файл вместо store.ts.
//
//   billing_accounts  – счёт: баланс, тариф, камеры, оплачено до, статус, автопродление, карта, почта для чеков
//   billing_payments  – платежи ЮKassa (id = номер платежа в ЮKassa): оплаты и автоплатежи
//   billing_cards     – привязки карт без оплаты (id = номер способа оплаты в ЮKassa)
//   billing_ledger    – журнал: зачисления, списания, пробный период
//
// Схема – server/schema.sql. Суммы – копейки (bigint), даты – timestamptz.
// Все изменения счёта идут в транзакции под блокировкой строки счёта (SELECT … FOR UPDATE),
// поэтому вебхук, ежедневное списание и открытие профиля не мешают друг другу.

import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  type Account, type Card, type Entry, type Period, type PlanId, type Selection, TARIFFS, applyCharges, applyTopup,
  autopayAmount, autopayAttempt, checkSelection, emptyAccount, isPlan, plural, rub, startTrial,
} from "./tariffs.js";
import {
  DEAD_CARD, type YkPayment, type YkPaymentMethod, cardTitle, createPayment, createPaymentMethod, getPayment,
  getPaymentMethod, reasonText, valueToKop,
} from "./yookassa.js";
import { HttpError } from "./server.js";

type Client = pg.PoolClient;
type Row = Record<string, unknown>;

let pool: pg.Pool | null = null;

function db(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(503, "Оплата ещё не настроена: нет базы на сервере");
  pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on("error", (e) => console.error("postgres", e));
  return pool;
}

/** Закрыть соединения с базой (при остановке сервера и в тестах). */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

async function inTx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const ms = (t: unknown): number | null => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : null);
const date = (x: number | null | undefined): Date | null => (x == null ? null : new Date(x));
const num = (x: unknown, d = 0): number => (x == null ? d : Number(x)); // bigint приходит строкой

function toAccount(r: Row | undefined): Account {
  if (!r) return emptyAccount();
  const e = emptyAccount();
  return {
    balance: num(r.balance),
    plan: isPlan(r.plan) ? r.plan : null,
    cameras: r.cameras == null ? e.cameras : num(r.cameras),
    annualUntil: ms(r.annual_until),
    paidUntil: ms(r.paid_until),
    status: ["none", "trial", "active", "expired"].includes(r.status as string) ? (r.status as Account["status"]) : "none",
    trialUsed: r.trial_used === true,
    autoRenew: r.auto_renew !== false,
    card: typeof r.card_id === "string" ? { id: r.card_id, title: String(r.card_title ?? "") } : null,
    autopayError: typeof r.autopay_error === "string" ? r.autopay_error : null,
  };
}

async function saveAccount(c: Client, uid: string, a: Account, email?: string | null): Promise<void> {
  await c.query(
    `UPDATE billing_accounts SET balance = $2, plan = $3, cameras = $4, annual_until = $5, paid_until = $6, status = $7,
       trial_used = $8, auto_renew = $9, card_id = $10, card_title = $11, autopay_error = $12,
       email = COALESCE($13, email), updated_at = now()
     WHERE uid = $1`,
    [uid, a.balance, a.plan, a.cameras, date(a.annualUntil), date(a.paidUntil), a.status, a.trialUsed, a.autoRenew,
      a.card?.id ?? null, a.card?.title ?? null, a.autopayError, email || null],
  );
}

async function insertEntry(c: Client, uid: string, e: Entry, id?: string | null): Promise<void> {
  await c.query(
    `INSERT INTO billing_ledger (id, uid, type, amount, balance_after, at, plan, cameras, from_at, to_at, annual, payment_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [id ?? randomUUID(), uid, e.type, e.amount, e.balanceAfter, new Date(e.at), e.plan, e.cameras, date(e.from), date(e.to),
      e.annual ?? null, e.paymentId ?? null, e.note],
  );
}

const ensureAccount = (c: Client | pg.Pool, uid: string) =>
  c.query("INSERT INTO billing_accounts (uid) VALUES ($1) ON CONFLICT (uid) DO NOTHING", [uid]);

const same = (a: Account, b: Account) => JSON.stringify(a) === JSON.stringify(b);

type Change = { account: Account; entries: Entry[]; ids?: (string | null)[] };

/** Заблокировать счёт, изменить функцией, записать счёт и журнал – одной транзакцией. */
function update(uid: string, fn: (a: Account, now: number, c: Client) => Promise<Change> | Change, email?: string | null): Promise<Account> {
  return inTx(async (c) => {
    await ensureAccount(c, uid);
    const { rows } = await c.query("SELECT * FROM billing_accounts WHERE uid = $1 FOR UPDATE", [uid]);
    const before = toAccount(rows[0]);
    const r = await fn(before, Date.now(), c);
    if (!same(before, r.account) || r.entries.length || (email && rows[0]?.email !== email)) {
      await saveAccount(c, uid, r.account, email);
    }
    for (const [i, e] of r.entries.entries()) await insertEntry(c, uid, e, r.ids?.[i]);
    return r.account;
  });
}

export async function getAccount(uid: string): Promise<{ account: Account; email: string | null }> {
  const { rows } = await db().query("SELECT * FROM billing_accounts WHERE uid = $1", [uid]);
  return { account: toAccount(rows[0]), email: (rows[0]?.email as string | null | undefined) ?? null };
}

/** Счёт с проверкой сроков: если месяц закончился и на балансе хватает – списать за следующий. */
export function chargeDue(uid: string, email?: string | null): Promise<Account> {
  return update(uid, (a, now) => applyCharges(a, now), email);
}

export function setAutoRenew(uid: string, on: boolean): Promise<Account> {
  return update(uid, (a, now) => applyCharges({ ...a, autoRenew: on, autopayError: on ? a.autopayError : null }, now));
}

export function unbindCard(uid: string): Promise<Account> {
  return update(uid, (a) => ({ account: { ...a, card: null, autopayError: null }, entries: [] }));
}

export function beginTrial(uid: string, plan: PlanId, cameras: number, email: string | null): Promise<Account> {
  return update(uid, (a, now) => {
    const r = startTrial(a, plan, cameras, now);
    if (typeof r === "string") throw new HttpError(409, r);
    return { account: r.account, entries: [r.entry] };
  }, email);
}

/** Можно ли сейчас начать пробный период (проверка до привязки карты, чтобы не привязывать зря). */
export async function checkTrial(uid: string, plan: PlanId, cameras: number): Promise<Account> {
  const { account } = await getAccount(uid);
  const r = startTrial(account, plan, cameras, Date.now());
  if (typeof r === "string") throw new HttpError(409, r);
  return account;
}

// ---------------------------------------------------------------- платежи

interface PaymentRow {
  amount: number;
  plan: PlanId;
  cameras: number;
  period: Period;
  kind: "checkout" | "autopay";
  status: YkPayment["status"];
  credited: boolean;
}

/** Записать новый платёж. Если такой уже есть (повтор по ключу идемпотентности) – не трогаем. */
export async function savePayment(uid: string, p: YkPayment, sel: Selection, amount: number, description: string, kind: PaymentRow["kind"]): Promise<void> {
  await ensureAccount(db(), uid);
  await db().query(
    `INSERT INTO billing_payments (id, uid, amount, plan, cameras, period, description, kind, status, test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [p.id, uid, amount, sel.plan, sel.cameras, sel.period, description, kind, p.status, p.test === true],
  );
}

/** Платёж пришёл, а записи о нём нет (создан не нами или запись потерялась) – завести по данным ЮKassa. */
async function ensurePaymentRow(c: Client, uid: string, p: YkPayment, kind: PaymentRow["kind"]): Promise<void> {
  const m = p.metadata ?? {};
  await c.query(
    `INSERT INTO billing_payments (id, uid, amount, plan, cameras, period, description, kind, status, test, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [p.id, uid, valueToKop(p.amount.value), m.plan ?? null, m.cameras ? Number(m.cameras) : null, m.period ?? null,
      p.description ?? "", kind, p.status, p.test === true, new Date(p.created_at)],
  );
}

const savedCard = (p: YkPayment): Card | null =>
  p.payment_method?.saved && p.payment_method.id ? { id: p.payment_method.id, title: cardTitle(p.payment_method) } : null;

/**
 * Применить состояние платежа из ЮKassa. Успешный платёж зачисляется ровно один раз (флаг credited в транзакции),
 * сумма сверяется с той, что сервер сам выставил. Неудачный автоплатёж записывается в счёт как ошибка.
 */
export async function applyPayment(p: YkPayment): Promise<"credited" | "already" | "updated" | "ignored"> {
  const uid = p.metadata?.uid;
  if (!uid) return "ignored";
  let result: "credited" | "already" | "updated" | "ignored" = "ignored";
  await update(uid, async (a, now, c) => {
    const { rows } = await c.query("SELECT * FROM billing_payments WHERE id = $1 FOR UPDATE", [p.id]);
    const rec = rows[0] ? ({ ...rows[0], amount: num(rows[0].amount), cameras: num(rows[0].cameras) } as unknown as PaymentRow) : undefined;
    const kind = rec?.kind ?? (p.metadata?.kind === "autopay" ? "autopay" : "checkout");
    if (rec?.credited) {
      result = "already";
      return { account: a, entries: [] };
    }
    if (!rec) await ensurePaymentRow(c, uid, p, kind);
    if (p.status !== "succeeded" || !p.paid) {
      if (rec && rec.status === p.status) return { account: a, entries: [] };
      await c.query("UPDATE billing_payments SET status = $2, cancel = COALESCE($3, cancel) WHERE id = $1",
        [p.id, p.status, p.cancellation_details ? JSON.stringify(p.cancellation_details) : null]);
      result = "updated";
      if (kind === "autopay" && p.status === "canceled") {
        const reason = p.cancellation_details?.reason;
        const dead = reason ? DEAD_CARD.has(reason) : false;
        const amount = rec?.amount ?? valueToKop(p.amount.value);
        return {
          account: {
            ...a,
            card: dead ? null : a.card,
            autopayError: `Не удалось списать ${rub(amount)} с карты${a.card ? ` ${a.card.title}` : ""}: ${reasonText(reason)}.${dead ? " Карта отвязана – привяжите новую или оплатите вручную." : ""}`,
          },
          entries: [],
        };
      }
      return { account: a, entries: [] };
    }
    const sel: Partial<Selection> = rec
      ? { plan: rec.plan, cameras: rec.cameras, period: rec.period }
      : { plan: p.metadata?.plan as PlanId, cameras: Number(p.metadata?.cameras), period: p.metadata?.period as Period };
    const err = checkSelection(sel);
    const paid = valueToKop(p.amount.value);
    if (err || p.amount.currency !== "RUB" || (rec && rec.amount !== paid)) {
      console.error("Платёж не сходится", p.id, err, p.amount, rec?.amount);
      await c.query("UPDATE billing_payments SET status = $2, credited = false, mismatch = true WHERE id = $1", [p.id, p.status]);
      result = "updated";
      return { account: a, entries: [] };
    }
    const card = savedCard(p);
    const r = applyTopup({ ...a, card: card ?? a.card }, sel as Selection, paid, p.id, now, kind === "autopay");
    await c.query("UPDATE billing_payments SET status = $2, credited = true, paid_at = $3, test = $4 WHERE id = $1",
      [p.id, p.status, new Date(p.captured_at ?? Date.now()), p.test === true]);
    result = "credited";
    // запись о зачислении – с номером платежа, чтобы повтор не создал вторую
    return { ...r, ids: r.entries.map((e) => (e.type === "topup" ? `pay_${p.id}` : null)) };
  });
  return result;
}

// ---------------------------------------------------------------- карты и автоплатежи

/** Начать привязку карты без оплаты. purpose = trial – после привязки сразу начнётся пробный период. */
export async function startCardBinding(uid: string, returnUrl: string, purpose: "trial" | "bind", plan?: PlanId, cameras?: number): Promise<string> {
  const meta: Record<string, string> = { uid, purpose, ...(plan ? { plan, cameras: String(cameras ?? 1) } : {}) };
  const m = await createPaymentMethod({ returnUrl, metadata: meta, idempotenceKey: randomUUID() });
  await ensureAccount(db(), uid);
  await db().query(
    `INSERT INTO billing_cards (id, uid, status, purpose, plan, cameras) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, purpose = EXCLUDED.purpose, plan = EXCLUDED.plan, cameras = EXCLUDED.cameras`,
    [m.id, uid, m.status, purpose, plan ?? null, cameras ?? null],
  );
  const url = m.confirmation?.confirmation_url;
  if (!url) throw new HttpError(502, "ЮKassa не вернула страницу привязки карты");
  return url;
}

/** Карта привязана (или нет): записать в счёт; если привязывали для пробного периода – начать его. */
export async function applyPaymentMethod(m: YkPaymentMethod): Promise<"saved" | "already" | "failed" | "ignored"> {
  const uid = m.metadata?.uid;
  if (!uid) return "ignored";
  let result: "saved" | "already" | "failed" | "ignored" = "ignored";
  await update(uid, async (a, now, c) => {
    await c.query(
      `INSERT INTO billing_cards (id, uid, status, purpose, plan, cameras) VALUES ($1, $2, 'pending', $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [m.id, uid, m.metadata?.purpose ?? null, m.metadata?.plan ?? null, m.metadata?.cameras ? Number(m.metadata.cameras) : null],
    );
    const { rows } = await c.query("SELECT * FROM billing_cards WHERE id = $1 FOR UPDATE", [m.id]);
    const row = rows[0] as Row;
    const purpose = (row.purpose as string | null) ?? m.metadata?.purpose;
    if (row.status === "active") {
      result = "already";
      return { account: a, entries: [] };
    }
    if (m.status !== "active" || !m.saved) {
      if (m.status === "inactive") {
        await c.query("UPDATE billing_cards SET status = 'inactive' WHERE id = $1", [m.id]);
        result = "failed";
      }
      return { account: a, entries: [] };
    }
    await c.query("UPDATE billing_cards SET status = 'active', title = $2, activated_at = now() WHERE id = $1", [m.id, cardTitle(m)]);
    result = "saved";
    const withCard: Account = { ...a, card: { id: m.id, title: cardTitle(m) }, autopayError: null };
    if (purpose === "trial") {
      const plan = (row.plan ?? m.metadata?.plan) as PlanId;
      const cameras = Number(row.cameras ?? m.metadata?.cameras);
      const t = isPlan(plan) ? startTrial(withCard, plan, cameras, now) : "нет тарифа";
      if (typeof t !== "string") return { account: t.account, entries: [t.entry] };
      console.error("Карта привязана, пробный период не начат", uid, t);
    }
    return applyCharges(withCard, now);
  });
  return result;
}

/**
 * Автоплатёж: если срок подписки наступил, а на балансе не хватает – списать недостающее с карты.
 * Одна попытка в сутки (ключ идемпотентности ЮKassa = счёт + срок + номер дня), не дольше 3 дней.
 */
export async function autopay(uid: string): Promise<"none" | "credited" | "failed" | "pending"> {
  const { account: a, email } = await getAccount(uid);
  const now = Date.now();
  const amount = autopayAmount(a, now);
  if (amount == null || !a.card || !a.plan) return "none";
  const sel: Selection = { plan: a.plan, cameras: a.cameras, period: "month" };
  const description = `Mantis, продление «${TARIFFS[a.plan].name}», ${a.cameras} ${plural(a.cameras, "камера", "камеры", "камер")}, 1 мес.`;
  const p = await createPayment({
    amount, description, paymentMethodId: a.card.id, email,
    metadata: { uid, plan: a.plan, cameras: String(a.cameras), period: "month", kind: "autopay" },
    idempotenceKey: `ap-${uid}-${a.paidUntil}-${autopayAttempt(a, now)}`,
  });
  await savePayment(uid, p, sel, amount, description, "autopay");
  const r = await applyPayment(p);
  return r === "credited" ? "credited" : p.status === "canceled" ? "failed" : "pending";
}

/** Продлить: списать с баланса, при нехватке – с карты. Ошибки автоплатежа не мешают показать счёт. */
export async function renew(uid: string, email?: string | null): Promise<Account> {
  let a = await chargeDue(uid, email);
  if (autopayAmount(a, Date.now()) != null) {
    try {
      if ((await autopay(uid)) !== "none") a = await chargeDue(uid);
    } catch (e) {
      console.error("autopay", uid, e);
    }
  }
  return a;
}

/** Проверить незавершённые платежи и привязки карт напрямую в ЮKassa – на случай, если уведомление не дошло. */
export async function syncPending(uid: string): Promise<void> {
  const q = db();
  // старше двух суток – уже не завершатся
  await q.query("UPDATE billing_payments SET status = 'canceled', expired = true WHERE uid = $1 AND status = 'pending' AND created_at < now() - interval '2 days'", [uid]);
  await q.query("UPDATE billing_cards SET status = 'inactive', expired = true WHERE uid = $1 AND status = 'pending' AND created_at < now() - interval '2 days'", [uid]);
  const [pays, cards] = await Promise.all([
    q.query("SELECT id FROM billing_payments WHERE uid = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 5", [uid]),
    q.query("SELECT id FROM billing_cards WHERE uid = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 3", [uid]),
  ]);
  await Promise.all([
    ...pays.rows.map(async (r: Row) => {
      try {
        await applyPayment(await getPayment(String(r.id)));
      } catch (e) {
        console.error("syncPending payment", r.id, e);
      }
    }),
    ...cards.rows.map(async (r: Row) => {
      try {
        await applyPaymentMethod(await getPaymentMethod(String(r.id)));
      } catch (e) {
        console.error("syncPending card", r.id, e);
      }
    }),
  ]);
}

export interface LedgerItem {
  type: Entry["type"];
  amount: number;
  balanceAfter: number;
  at: number;
  note: string;
  from: number | null;
  to: number | null;
}

export async function ledger(uid: string, limit = 20): Promise<LedgerItem[]> {
  const { rows } = await db().query("SELECT * FROM billing_ledger WHERE uid = $1 ORDER BY at DESC LIMIT $2", [uid, limit]);
  return rows.map((x: Row) => ({
    type: x.type as Entry["type"], amount: num(x.amount), balanceAfter: num(x.balance_after), at: ms(x.at) ?? 0,
    note: String(x.note ?? ""), from: ms(x.from_at), to: ms(x.to_at),
  }));
}

/** Ежедневное продление: все счета, у которых срок подписки наступил (с баланса, при нехватке – с карты). */
export async function chargeAllDue(): Promise<{ checked: number; renewed: number; failed: number }> {
  const { rows } = await db().query(
    "SELECT uid, paid_until FROM billing_accounts WHERE paid_until <= now() AND auto_renew AND plan IS NOT NULL ORDER BY paid_until LIMIT 1000",
  );
  let renewed = 0;
  let failed = 0;
  for (const r of rows as Row[]) {
    try {
      const before = ms(r.paid_until) ?? 0;
      const a = await renew(String(r.uid));
      if (a.paidUntil != null && a.paidUntil > before) renewed++;
    } catch (e) {
      failed++;
      console.error("chargeAllDue", r.uid, e);
    }
  }
  return { checked: rows.length, renewed, failed };
}
