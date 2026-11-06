// Клиент сервера оплаты (/api/billing/*). На Vercel и на mantis.rcmit.ru – тот же адрес; в Агенте и при разработке – основной сайт.
import type { Account, Entry, Selection } from "../../api/_lib/tariffs";
import { idToken } from "../cloud/firebase";

const MAIN = "https://mantis-web-snowy.vercel.app";

function base(): string {
  const env = import.meta.env.VITE_BILLING_URL as string | undefined;
  if (env) return env.replace(/\/$/, "");
  return /(\.vercel\.app|(^|\.)rcmit\.ru)$/.test(location.hostname) ? "" : MAIN;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const token = await idToken();
  const r = await fetch(`${base()}/api/billing/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error("Нет связи с сервером оплаты");
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Сервер оплаты ответил ${r.status}`);
  return data;
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

export interface BillingStatus {
  account: Account;
  next: { at: number; amount: number; enough: boolean; fromCard: number } | null;
  ledger: LedgerItem[];
  now: number;
  /** Автоплатежи с карты подключены на сервере. */
  autopay: boolean;
}

export const billing = {
  status: () => call<BillingStatus>("status"),
  pay: (s: Selection, saveCard: boolean) => call<{ url: string; paymentId: string }>("pay", { ...s, saveCard }),
  /** {url} – привязать карту на странице ЮKassa; {account} – пробный период уже начался. */
  trial: (plan: Selection["plan"], cameras: number) => call<{ url?: string; account?: Account }>("trial", { plan, cameras }),
  bindCard: () => call<{ url: string }>("card", { action: "bind" }),
  unbindCard: () => call<{ account: Account }>("card", { action: "unbind" }),
  autoRenew: (on: boolean) => call<{ account: Account }>("autorenew", { on }),
};

export type ReturnKind = "payment" | "card";

/** Пользователь вернулся со страницы ЮKassa: после оплаты (?payment=return) или привязки карты (?card=return). */
export function takePaymentReturn(): ReturnKind | null {
  const u = new URL(location.href);
  const kind: ReturnKind | null = u.searchParams.get("payment") === "return" ? "payment" : u.searchParams.get("card") === "return" ? "card" : null;
  if (!kind) return null;
  u.searchParams.delete("payment");
  u.searchParams.delete("card");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
  return kind;
}
