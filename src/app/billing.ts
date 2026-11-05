// Клиент сервера оплаты (/api/billing/*). На Vercel – тот же адрес; в Агенте и при разработке – основной сайт.
import type { Account, Entry, Selection } from "../../api/_lib/tariffs";
import { idToken } from "../cloud/firebase";

const MAIN = "https://mantis-web-snowy.vercel.app";

function base(): string {
  const env = import.meta.env.VITE_BILLING_URL as string | undefined;
  if (env) return env.replace(/\/$/, "");
  return /\.vercel\.app$/.test(location.hostname) ? "" : MAIN;
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
  next: { at: number; amount: number; enough: boolean } | null;
  ledger: LedgerItem[];
  now: number;
}

export const billing = {
  status: () => call<BillingStatus>("status"),
  pay: (s: Selection) => call<{ url: string; paymentId: string }>("pay", s),
  trial: (plan: Selection["plan"], cameras: number) => call<{ account: Account }>("trial", { plan, cameras }),
  autoRenew: (on: boolean) => call<{ account: Account }>("autorenew", { on }),
};

/** Пользователь вернулся со страницы оплаты ЮKassa (?payment=return). Убираем отметку из адреса. */
export function takePaymentReturn(): boolean {
  const u = new URL(location.href);
  if (u.searchParams.get("payment") !== "return") return false;
  u.searchParams.delete("payment");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
  return true;
}
