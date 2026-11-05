// ЮKassa API v3: создание платежа и проверка его состояния. Документация: https://yookassa.ru/developers/api

import { HttpError } from "./server.js";

const API = "https://api.yookassa.ru/v3";

export interface YkPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  amount: { value: string; currency: string };
  description?: string;
  metadata?: Record<string, string>;
  confirmation?: { type: string; confirmation_url?: string };
  created_at: string;
  captured_at?: string;
  cancellation_details?: { party: string; reason: string };
  test?: boolean;
}

function authHeader(): string {
  const shop = process.env.YOOKASSA_SHOP_ID;
  const key = process.env.YOOKASSA_SECRET_KEY;
  if (!shop || !key) throw new HttpError(503, "Оплата ещё не настроена: нет ключей ЮKassa");
  return `Basic ${Buffer.from(`${shop}:${key}`).toString("base64")}`;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: authHeader(), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) {
    console.error("ЮKassa", r.status, text);
    let msg = "";
    try {
      msg = (JSON.parse(text) as { description?: string }).description ?? "";
    } catch {
      /* не JSON */
    }
    throw new HttpError(502, `ЮKassa не приняла запрос${msg ? `: ${msg}` : ""}`);
  }
  return JSON.parse(text) as T;
}

export const kopToValue = (kop: number): string => (kop / 100).toFixed(2);
export const valueToKop = (v: string): number => Math.round(parseFloat(v) * 100);

export async function createPayment(o: {
  amount: number;
  description: string;
  returnUrl: string;
  metadata: Record<string, string>;
  email: string | null;
  idempotenceKey: string;
}): Promise<YkPayment> {
  const amount = { value: kopToValue(o.amount), currency: "RUB" };
  const vat = process.env.YOOKASSA_VAT_CODE;
  const receipt = vat && o.email
    ? {
      customer: { email: o.email },
      items: [{
        description: o.description.slice(0, 128), quantity: "1.00", amount, vat_code: Number(vat),
        payment_mode: "full_prepayment", payment_subject: "service",
      }],
    }
    : undefined;
  return call<YkPayment>("/payments", {
    method: "POST",
    headers: { "Idempotence-Key": o.idempotenceKey },
    body: JSON.stringify({
      amount,
      capture: true,
      confirmation: { type: "redirect", return_url: o.returnUrl },
      description: o.description.slice(0, 128),
      metadata: o.metadata,
      ...(receipt ? { receipt } : {}),
    }),
  });
}

export function getPayment(id: string): Promise<YkPayment> {
  if (!/^[\w-]{10,64}$/.test(id)) throw new HttpError(400, "Неверный номер платежа");
  return call<YkPayment>(`/payments/${id}`);
}
