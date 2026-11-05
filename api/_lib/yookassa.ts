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
  payment_method?: YkMethodInfo;
  test?: boolean;
}

interface YkMethodInfo {
  id: string;
  type: string;
  saved: boolean;
  title?: string;
  card?: { first6?: string; last4: string; card_type?: string; expiry_month?: string; expiry_year?: string };
}

/** Сохранённый способ оплаты (карта), привязанный без платежа. */
export interface YkPaymentMethod extends YkMethodInfo {
  status: "pending" | "active" | "inactive";
  metadata?: Record<string, string>;
  confirmation?: { type: string; confirmation_url?: string };
}

/** Автоплатежи (сохранение карт) включены: в тестовом магазине всегда, в боевом – после подключения менеджером ЮKassa. */
export const autopayEnabled = (): boolean => process.env.YOOKASSA_AUTOPAY === "1";

/** «Карта •••• 4444» для профиля. */
export function cardTitle(m: YkMethodInfo): string {
  if (m.card?.last4) return `${m.card.card_type && m.card.card_type !== "Unknown" ? `${m.card.card_type} ` : ""}•••• ${m.card.last4}`;
  return m.title ?? "Сохранённая карта";
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

/**
 * Создать платёж. С returnUrl – пользователь подтверждает на странице ЮKassa (saveCard – сохранить карту для автоплатежей).
 * С paymentMethodId – автоплатёж с сохранённой карты, без участия пользователя.
 */
export async function createPayment(o: {
  amount: number;
  description: string;
  returnUrl?: string;
  paymentMethodId?: string;
  saveCard?: boolean;
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
      ...(o.paymentMethodId
        ? { payment_method_id: o.paymentMethodId }
        : { confirmation: { type: "redirect", return_url: o.returnUrl }, ...(o.saveCard ? { save_payment_method: true } : {}) }),
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

/** Привязать карту без оплаты: ЮKassa проверяет карту на своей странице, деньги не списываются. */
export function createPaymentMethod(o: { returnUrl: string; metadata: Record<string, string>; idempotenceKey: string }): Promise<YkPaymentMethod> {
  return call<YkPaymentMethod>("/payment_methods", {
    method: "POST",
    headers: { "Idempotence-Key": o.idempotenceKey },
    body: JSON.stringify({ type: "bank_card", confirmation: { type: "redirect", return_url: o.returnUrl }, metadata: o.metadata }),
  });
}

export function getPaymentMethod(id: string): Promise<YkPaymentMethod> {
  if (!/^[\w-]{10,64}$/.test(id)) throw new HttpError(400, "Неверный номер способа оплаты");
  return call<YkPaymentMethod>(`/payment_methods/${id}`);
}

/** Причины отказа автоплатежа, после которых карту больше не пробуем. */
export const DEAD_CARD = new Set(["permission_revoked", "card_expired", "payment_method_restricted", "invalid_card_number", "country_forbidden"]);

const REASONS: Record<string, string> = {
  insufficient_funds: "на карте недостаточно средств",
  card_expired: "срок действия карты истёк",
  permission_revoked: "автоплатежи по карте отключены",
  payment_method_restricted: "операции по карте ограничены",
  issuer_unavailable: "банк карты недоступен",
  fraud_suspected: "банк заподозрил мошенничество",
  call_issuer: "банк отклонил платёж – обратитесь в банк",
  general_decline: "банк отклонил платёж",
  country_forbidden: "оплата картами этой страны недоступна",
  invalid_card_number: "карта недействительна",
};

export const reasonText = (reason?: string): string => REASONS[reason ?? ""] ?? "платёж отклонён";

