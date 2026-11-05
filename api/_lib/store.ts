// База оплат в Firestore. Пишет только сервер (Firebase Admin), браузер читает через /api/billing/status.
//
//   mantis_billing/{uid}                     – счёт: баланс, тариф, камеры, оплачено до, статус, автопродление
//   mantis_billing/{uid}/payments/{id}       – платежи ЮKassa (id = номер платежа в ЮKassa)
//   mantis_billing/{uid}/ledger/{id}         – журнал: зачисления, списания, пробный период
//
// Все суммы – в копейках (целые), даты – Timestamp. Коллекции с префиксом mantis_, потому что
// проект Firebase общий с другими приложениями.

import { type DocumentData, type Firestore, Timestamp, type Transaction } from "firebase-admin/firestore";
import {
  type Account, type Entry, type Period, type PlanId, type Selection, applyCharges, applyTopup, checkSelection, emptyAccount,
  isPlan, startTrial,
} from "./tariffs.js";
import { type YkPayment, getPayment, valueToKop } from "./yookassa.js";
import { HttpError, db } from "./server.js";

export const BILLING = "mantis_billing";

const ts = (ms: number | null | undefined) => (ms == null ? null : Timestamp.fromMillis(ms));
const ms = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : typeof t === "number" ? t : null);

function toAccount(d: DocumentData | undefined): Account {
  if (!d) return emptyAccount();
  const e = emptyAccount();
  return {
    balance: typeof d.balance === "number" ? d.balance : 0,
    plan: isPlan(d.plan) ? d.plan : null,
    cameras: typeof d.cameras === "number" ? d.cameras : e.cameras,
    annualUntil: ms(d.annualUntil),
    paidUntil: ms(d.paidUntil),
    status: ["none", "trial", "active", "expired"].includes(d.status) ? d.status : "none",
    trialUsed: d.trialUsed === true,
    autoRenew: d.autoRenew !== false,
  };
}

function accountDoc(a: Account, email?: string | null): DocumentData {
  return {
    balance: a.balance, plan: a.plan, cameras: a.cameras, annualUntil: ts(a.annualUntil), paidUntil: ts(a.paidUntil),
    status: a.status, trialUsed: a.trialUsed, autoRenew: a.autoRenew, updatedAt: Timestamp.now(),
    ...(email ? { email } : {}),
  };
}

function entryDoc(e: Entry): DocumentData {
  const { at, from, to, ...rest } = e;
  return Object.fromEntries(Object.entries({ ...rest, at: ts(at), from: ts(from), to: ts(to) }).filter(([, v]) => v !== undefined));
}

const same = (a: Account, b: Account) => JSON.stringify(a) === JSON.stringify(b);

/** Прочитать счёт в транзакции, изменить функцией, записать счёт и журнал. */
async function update(
  uid: string,
  fn: (a: Account, now: number, tx: Transaction) => Promise<{ account: Account; entries: Entry[]; ids?: (string | null)[] }> | { account: Account; entries: Entry[]; ids?: (string | null)[] },
  email?: string | null,
): Promise<Account> {
  const f: Firestore = db();
  const ref = f.collection(BILLING).doc(uid);
  return f.runTransaction(async (tx) => {
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

/** Счёт с проверкой сроков: если месяц закончился – списать за следующий. */
export function chargeDue(uid: string, email?: string | null): Promise<Account> {
  return update(uid, (a, now) => applyCharges(a, now), email);
}

export function setAutoRenew(uid: string, on: boolean): Promise<Account> {
  return update(uid, (a, now) => applyCharges({ ...a, autoRenew: on }, now));
}

export function beginTrial(uid: string, plan: PlanId, cameras: number, email: string | null): Promise<Account> {
  return update(uid, (a, now) => {
    const r = startTrial(a, plan, cameras, now);
    if (typeof r === "string") throw new HttpError(409, r);
    return { account: r.account, entries: [r.entry] };
  }, email);
}

export interface PaymentRecord {
  amount: number;
  plan: PlanId;
  cameras: number;
  period: Period;
  description: string;
  status: YkPayment["status"];
  credited: boolean;
  createdAt: Timestamp;
  paidAt?: Timestamp | null;
  test?: boolean;
}

export async function savePayment(uid: string, p: YkPayment, sel: Selection, amount: number, description: string): Promise<void> {
  const rec: PaymentRecord = {
    amount, plan: sel.plan, cameras: sel.cameras, period: sel.period, description, status: p.status, credited: false,
    createdAt: Timestamp.now(), test: p.test === true,
  };
  await db().collection(BILLING).doc(uid).collection("payments").doc(p.id).set(rec);
}

/**
 * Применить состояние платежа из ЮKassa. Успешный платёж зачисляется ровно один раз (флаг credited в транзакции),
 * сумма сверяется с той, что сервер сам выставил.
 */
export async function applyPayment(p: YkPayment): Promise<"credited" | "already" | "updated" | "ignored"> {
  const uid = p.metadata?.uid;
  if (!uid) return "ignored";
  const ref = db().collection(BILLING).doc(uid).collection("payments").doc(p.id);
  let result: "credited" | "already" | "updated" | "ignored" = "ignored";
  await update(uid, async (a, now, tx) => {
    const snap = await tx.get(ref);
    const rec = snap.data() as PaymentRecord | undefined;
    if (rec?.credited) {
      result = "already";
      return { account: a, entries: [] };
    }
    if (p.status !== "succeeded" || !p.paid) {
      if (rec && rec.status !== p.status) {
        tx.update(ref, { status: p.status, ...(p.cancellation_details ? { cancel: p.cancellation_details } : {}) });
        result = "updated";
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
    const r = applyTopup(a, sel as Selection, paid, p.id, now);
    tx.set(ref, {
      ...(rec ? {} : { amount: paid, ...sel, description: p.description ?? "", createdAt: Timestamp.fromDate(new Date(p.created_at)) }),
      status: p.status, credited: true, paidAt: Timestamp.fromDate(new Date(p.captured_at ?? Date.now())), test: p.test === true,
    }, { merge: true });
    result = "credited";
    // запись о зачислении – с номером платежа, чтобы повтор не создал вторую
    return { ...r, ids: r.entries.map((e) => (e.type === "topup" ? `pay_${p.id}` : null)) };
  });
  return result;
}

/** Проверить незавершённые платежи пользователя напрямую в ЮKassa – на случай, если уведомление не дошло. */
export async function syncPending(uid: string): Promise<void> {
  const snap = await db().collection(BILLING).doc(uid).collection("payments").where("status", "==", "pending").limit(5).get();
  const dayAgo = Date.now() - 2 * 24 * 3600_000;
  await Promise.all(snap.docs.map(async (d) => {
    const created = ms(d.get("createdAt")) ?? 0;
    if (created < dayAgo) return d.ref.update({ status: "canceled", expired: true });
    try {
      await applyPayment(await getPayment(d.id));
    } catch (e) {
      console.error("syncPending", d.id, e);
    }
  }));
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
  const snap = await db().collection(BILLING).doc(uid).collection("ledger").orderBy("at", "desc").limit(limit).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return { type: x.type, amount: x.amount, balanceAfter: x.balanceAfter, at: ms(x.at) ?? 0, note: x.note ?? "", from: ms(x.from), to: ms(x.to) };
  });
}

/** Ежедневное списание: все счета, у которых срок подписки наступил. */
export async function chargeAllDue(): Promise<{ checked: number; charged: number; failed: number }> {
  const now = Timestamp.now();
  const snap = await db().collection(BILLING).where("paidUntil", "<=", now).limit(1000).get();
  let charged = 0;
  let failed = 0;
  for (const d of snap.docs) {
    if (d.get("autoRenew") === false || !d.get("plan")) continue;
    try {
      const before = d.get("paidUntil") as Timestamp;
      const a = await chargeDue(d.id);
      if (a.paidUntil != null && a.paidUntil > before.toMillis()) charged++;
    } catch (e) {
      failed++;
      console.error("chargeAllDue", d.id, e);
    }
  }
  return { checked: snap.size, charged, failed };
}
