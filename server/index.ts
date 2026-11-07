// Сервер API Mantis для своего хостинга (прод: mantis.rcmit.ru) – вместо функций Vercel.
// Те же обработчики api/*, база оплат – PostgreSQL (store-pg.ts). nginx отдаёт фронт и проксирует сюда /api/*.
//
//   node server.cjs          – слушать HOST:PORT (по умолчанию 127.0.0.1:3100)
//   node server.cjs charge   – ежедневное продление подписок и выход (запускает таймер systemd)
//
// Переменные окружения – см. deploy/mantis.env.example.

import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import autorenew from "../api/billing/autorenew.js";
import card from "../api/billing/card.js";
import pay from "../api/billing/pay.js";
import status from "../api/billing/status.js";
import trial from "../api/billing/trial.js";
import webhook from "../api/yookassa/webhook.js";
import { chargeAllDue, closeDb } from "../api/_lib/store-pg.js";

type Handler = { fetch: (req: Request) => Promise<Response> };

// /api/cron/charge наружу не открываем: списание запускает таймер (node server.cjs charge)
const ROUTES: Record<string, Handler> = {
  "/api/billing/autorenew": autorenew,
  "/api/billing/card": card,
  "/api/billing/pay": pay,
  "/api/billing/status": status,
  "/api/billing/trial": trial,
  "/api/yookassa/webhook": webhook,
};

const MAX_BODY = 1 << 20;

/** Версия релиза (коммит) – файл version.txt рядом с server.cjs, кладёт сборка релиза. */
const VERSION = (() => {
  try {
    return readFileSync(join(__dirname, "version.txt"), "utf8").trim();
  } catch {
    return "dev";
  }
})();

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const method = req.method ?? "GET";
  return new Request(`${proto}://${host}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" || body.length === 0 ? undefined : new Uint8Array(body),
  });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await r.arrayBuffer()));
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");
  if (path === "/api/health") return sendJson(res, 200, { ok: true, version: VERSION });
  const h = ROUTES[path];
  if (!h) return sendJson(res, 404, { error: "Не найдено" });
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 413, { error: "Слишком большой запрос" });
  }
  await send(res, await h.fetch(toRequest(req, body)));
}

async function main(): Promise<void> {
  if (process.argv[2] === "charge") {
    const r = await chargeAllDue();
    console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
    await closeDb();
    return;
  }
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3100);
  const server = createServer((req, res) => {
    serve(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: "Ошибка сервера, попробуйте позже" });
      else res.end();
    });
  });
  server.listen(port, host, () => console.log(`Mantis API: http://${host}:${port}`));
  const stop = () => {
    server.close(() => void closeDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
