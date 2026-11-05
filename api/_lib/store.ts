// База оплат в Firestore. Пишет только сервер (Firebase Admin), браузер читает через /api/billing/status.
//
//   mantis_billing/{uid}                     – счёт: баланс, тариф, камеры, оплачено до, статус, автопродление, карта
//   mantis_billing/{uid}/payments/{id}       – платежи ЮKassa (id = номер платежа в ЮKassa): оплаты и автоплатежи
//   mantis_billing/{uid}/cards/{id}          – привязки карт без оплаты (id = номер способа оплаты в ЮKassa)
//   mantis_billing/{uid}/ledger/{id}         – журнал: зачисления, списания, пробный период
//
// Все суммы – в копейках (целые), даты – Timestamp. Коллекции с префиксом mantis_, потому что
// проект Firebase общий с другими приложениями.

import { randomUUID } from "node:crypto";
import { type DocumentData, Timestamp, type Transaction } from "firebase-admin/firestore";
import {
  type Account, type Card, type Entry, type Period, type PlanId, type Selection, TARIFFS, applyCharges, applyTopup,
  autopayAmount, autopayAttempt, checkSelection, emptyAccount, isPlan, plural, rub, startTrial,
} from "./tariffs.js";
import {
  DEAD_CARD, type YkPayment, type YkPaymentMethod, cardTitle, createPayment, createPaymentMethod, getPayment,
  getPaymentMethod, reasonText, valueToKop,
} from "./yookassa.js";
import { HttpError, db } from "./server.js";

export const BILLING = "mantis_billing";

const ts = (ms: number | null | undefined) => (ms == null ? null : Timestamp.fromMillis(ms));
const ms = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : typeof t === "number" ? t : null);
const billingRef = (uid: string) => db().collection(BILLING).doc(uid);

function toAccount(d: DocumentData | undefined): Account {
  if (!d) return emptyAccount();
  const e = emptyAccount();
  const card = d.card && typeof d.card.id === "string" ? { id: d.card.id as string, title: String(d.card.title ?? "") } : null;
  return {
    balance: typeof d.balance === "number" ? d.balance : 0,
    plan: isPlan(d.plan) ? d.plan : null,
    cameras: typeof d.cameras === "number" ? d.cameras : e.cameras,
    annualUntil: ms(d.annualUntil),
    paidUntil: ms(d.paidUntil),
    status: ["none", "trial", "active", "expired"].includes(d.status) ? d.status : "none",
    trialUsed: d.trialUsed === true,
    autoRenew: d.autoRenew !== false,
    card,
    autopayError: typeof d.autopayError === "string" ? d.autopayError : null,
  };
}

function accountDoc(a: Account, email?: string | null): DocumentData {
  return {
    balance: a.balance, plan: a.plan, cameras: a.cameras, annualUntil: ts(a.annualUntil), paidUntil: ts(a.paidUntil),
    status: a.status, trialUsed: a.trialUsed, autoRenew: a.autoRenew, card: a.card, autopayError: a.autopayError,
    updatedAt: Timestamp.now(),
    ...(email ? { email } : {}),
  };
}

function entryDoc(e: Entry): DocumentData {
  const { at, from, to, ...rest } = e;
  return Object.fromEntries(Object.entries({ ...rest, at: ts(at), from: ts(from), to: ts(to) }).filter(([, v]) => v !== undefined));
}

const same = (a: Account, b: Account) => JSON.stringify(a) === JSON.stringify(b);

type Change = { account: Account; entries: Entry[]; ids?: (string | null)[] };

/** Прочитать счёт в транзакции, изменить функцией, записать счёт и журнал. */
async function update(
  uid: string,
  fn: (a: Account, now: number, tx: Transaction) => Promise<Change> | Change,
  email?: string | null,
): Promise<Account> {
  const ref = billingRef(uid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const before = toAccount(snap.data());
    const now = Date.now();
    const r = await fn(before, now, tx);
    if (!snap.exists || !same(before, r.account) || r.entries.length || (email && snap.get("email") !== email)) {
      tx.set(ref, accountDoc(r.account, email), { merge: true });
    }
    r.entries.forEach((e, i) => {
      const id = r.ids?.[i];
      tx.set(id ? ref.collection("ledger").doc(id) : ref.collection("ledger").doc(), entryDoc(e));
    });
    return r.account;
  });
}

export async function getAccount(uid: string): Promise<{ account: Account; email: string | null }> {
  const snap = await billingRef(uid).get();
  return { account: toAccount(snap.data()), email: (snap.get("email") as string | undefined) ?? null };
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

export interface PaymentRecord {
  amount: number;
  plan: PlanId;
  cameras: number;
  period: Period;
  description: string;
  kind: "checkout" | "autopay";
  status: YkPayment["status"];
  credited: boolean;
  createdAt: Timestamp;
  paidAt?: Timestamp | null;
  test?: boolean;
}

/** Записать новый платёж. Если такой уже есть (повтор по ключу идемпотентности) – не трогаем. */
export async function savePayment(uid: string, p: YkPayment, sel: Selection, amount: number, description: string, kind: PaymentRecord["kind"]): Promise<void> {
  const ref = billingRef(uid).collection("payments").doc(p.id);
  const rec: PaymentRecord = {
    amount, plan: sel.plan, cameras: sel.cameras, period: sel.period, description, kind, status: p.status, credited: false,
    createdAt: Timestamp.now(), test: p.test === true,
  };
  await ref.create(rec).catch((e: { code?: number }) => {
    if (e.code !== 6) throw e; // 6 = ALREADY_EXISTS
  });
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
  const ref = billingRef(uid).collection("payments").doc(p.id);
  let result: "credited" | "already" | "updated" | "ignored" = "ignored";
  await update(uid, async (a, now, tx) => {
    const snap = await tx.get(ref);
    const rec = snap.data() as PaymentRecord | undefined;
    const kind = rec?.kind ?? (p.metadata?.kind === "autopay" ? "autopay" : "checkout");
    if (rec?.credited) {
      result = "already";
      return { account: a, entries: [] };
    }
    if (p.status !== "succeeded" || !p.paid) {
      if (rec && rec.status === p.status) return { account: a, entries: [] };
      tx.set(ref, { status: p.status, ...(p.cancellation_details ? { cancel: p.cancellation_details } : {}) }, { merge: true });
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
      tx.set(ref, { status: p.status, credited: false, mismatch: true }, { merge: true });
      result = "updated";
      return { account: a, entries: [] };
    }
    const card = savedCard(p);
    const r = applyTopup({ ...a, card: card ?? a.card }, sel as Selection, paid, p.id, now, kind === "autopay");
    tx.set(ref, {
      ...(rec ? {} : { amount: paid, ...sel, kind, description: p.description ?? "", createdAt: Timestamp.fromDate(new Date(p.created_at)) }),
      status: p.status, credited: true, paidAt: Timestamp.fromDate(new Date(p.captured_at ?? Date.now())), test: p.test === true,
    }, { merge: true });
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
  await billingRef(uid).collection("cards").doc(m.id).set({
    status: m.status, purpose, plan: plan ?? null, cameras: cameras ?? null, createdAt: Timestamp.now(),
  });
  const url = m.confirmation?.confirmation_url;
  if (!url) throw new HttpError(502, "ЮKassa не вернула страницу привязки карты");
  return url;
}

/** Карта привязана (или нет): записать в счёт; если привязывали для пробного периода – начать его. */
export async function applyPaymentMethod(m: YkPaymentMethod): Promise<"saved" | "already" | "failed" | "ignored"> {
  const uid = m.metadata?.uid;
  if (!uid) return "ignored";
  const ref = billingRef(uid).collection("cards").doc(m.id);
  let result: "saved" | "already" | "failed" | "ignored" = "ignored";
  await update(uid, async (a, now, tx) => {
    const snap = await tx.get(ref);
    const purpose = (snap.get("purpose") as string | undefined) ?? m.metadata?.purpose;
    if (snap.get("status") === "active") {
      result = "already";
      return { account: a, entries: [] };
    }
    if (m.status !== "active" || !m.saved) {
      if (m.status === "inactive") {
        tx.set(ref, { status: "inactive" }, { merge: true });
        result = "failed";
      }
      return { account: a, entries: [] };
    }
    tx.set(ref, { status: "active", title: cardTitle(m), activatedAt: Timestamp.now() }, { merge: true });
    result = "saved";
    const withCard: Account = { ...a, card: { id: m.id, title: cardTitle(m) }, autopayError: null };
    if (purpose === "trial") {
      const plan = (snap.get("plan") ?? m.metadata?.plan) as PlanId;
      const cameras = Number(snap.get("cameras") ?? m.metadata?.cameras);
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
  const ref = billingRef(uid);
  const [pays, cards] = await Promise.all([
    ref.collection("payments").where("status", "==", "pending").limit(5).get(),
    ref.collection("cards").where("status", "==", "pending").limit(3).get(),
  ]);
  const dayAgo = Date.now() - 2 * 24 * 3600_000;
  await Promise.all([
    ...pays.docs.map(async (d) => {
      if ((ms(d.get("createdAt")) ?? 0) < dayAgo) return d.ref.update({ status: "canceled", expired: true });
      try {
        await applyPayment(await getPayment(d.id));
      } catch (e) {
        console.error("syncPending payment", d.id, e);
      }
    }),
    ...cards.docs.map(async (d) => {
      if ((ms(d.get("createdAt")) ?? 0) < dayAgo) return d.ref.update({ status: "inactive", expired: true });
      try {
        await applyPaymentMethod(await getPaymentMethod(d.id));
      } catch (e) {
        console.error("syncPending card", d.id, e);
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
  const snap = await billingRef(uid).collection("ledger").orderBy("at", "desc").limit(limit).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return { type: x.type, amount: x.amount, balanceAfter: x.balanceAfter, at: ms(x.at) ?? 0, note: x.note ?? "", from: ms(x.from), to: ms(x.to) };
  });
}

/** Ежедневное продление: все счета, у которых срок подписки наступил (с баланса, при нехватке – с карты). */
export async function chargeAllDue(): Promise<{ checked: number; renewed: number; failed: number }> {
  const snap = await db().collection(BILLING).where("paidUntil", "<=", Timestamp.now()).limit(1000).get();
  let renewed = 0;
  let failed = 0;
  for (const d of snap.docs) {
    if (d.get("autoRenew") === false || !d.get("plan")) continue;
    try {
      const before = (d.get("paidUntil") as Timestamp).toMillis();
      const a = await renew(d.id);
      if (a.paidUntil != null && a.paidUntil > before) renewed++;
    } catch (e) {
      failed++;
      console.error("chargeAllDue", d.id, e);
    }
  }
  return { checked: snap.size, renewed, failed };
}
