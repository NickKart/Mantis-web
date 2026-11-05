// Общее для функций Vercel: Firebase Admin (Firestore и проверка входа), ответы JSON, CORS.
// Переменные окружения (Vercel → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT – JSON ключа сервисного аккаунта Firebase (проект jinpix-ac93d), целиком одной строкой
//   YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY – магазин ЮKassa
//   YOOKASSA_VAT_CODE – если задан (например 1 – без НДС), к платежу прикладывается чек по 54-ФЗ
//   CRON_SECRET – секрет для ежедневного списания (Vercel передаёт его сам)
//   APP_URL – адрес приложения для возврата после оплаты (по умолчанию https://mantis-web-snowy.vercel.app)

import { type App, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { type Firestore, getFirestore } from "firebase-admin/firestore";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let app: App | null = null;

function adminApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) return (app = existing);
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new HttpError(503, "Оплата ещё не настроена: нет ключа Firebase на сервере");
  let sa: Record<string, string>;
  try {
    sa = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new HttpError(503, "Ключ Firebase на сервере повреждён");
  }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  app = initializeApp({ credential: cert(sa as never), projectId: sa.project_id });
  return app;
}

export function db(): Firestore {
  return getFirestore(adminApp());
}

export interface Caller {
  uid: string;
  email: string | null;
}

/** Кто вызывает: проверка токена Firebase из заголовка Authorization: Bearer <idToken>. */
export async function caller(req: Request): Promise<Caller> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw new HttpError(401, "Войдите в аккаунт");
  try {
    const t = await getAuth(adminApp()).verifyIdToken(token);
    return { uid: t.uid, email: t.email ?? null };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, "Вход устарел – войдите заново");
  }
}

function cors(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

export function json(req: Request, data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: cors(req) });
}

/** Обёртка обработчика: CORS, разрешённые методы, ошибки → JSON {error}. */
export function handler(methods: string[], fn: (req: Request) => Promise<Response>): { fetch: (req: Request) => Promise<Response> } {
  return {
    async fetch(req: Request) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (!methods.includes(req.method)) return json(req, { error: "Метод не поддерживается" }, 405);
      try {
        return await fn(req);
      } catch (e) {
        if (e instanceof HttpError) return json(req, { error: e.message }, e.status);
        console.error(e);
        return json(req, { error: "Ошибка сервера, попробуйте позже" }, 500);
      }
    },
  };
}

export async function body<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    throw new HttpError(400, "Неверный запрос");
  }
}

const DEFAULT_APP_URL = "https://mantis-web-snowy.vercel.app";

/** Куда вернуть пользователя после оплаты: адрес, с которого он пришёл, если он наш; иначе APP_URL. */
export function returnBase(req: Request): string {
  const allowed = (process.env.APP_URL ?? DEFAULT_APP_URL).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  const origin = (req.headers.get("origin") ?? "").replace(/\/$/, "");
  const ours = allowed.includes(origin)
    || /^https:\/\/mantis-web[a-z0-9-]*\.vercel\.app$/.test(origin)
    || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ours ? origin : allowed[0] ?? DEFAULT_APP_URL;
}
