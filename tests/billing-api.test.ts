import { describe, expect, it } from "vitest";
import status from "../api/billing/status";
import pay from "../api/billing/pay";
import webhook from "../api/yookassa/webhook";
import cron from "../api/cron/charge";
import { returnBase } from "../api/_lib/server";

const req = (url: string, init: RequestInit = {}) => new Request(`https://mantis-web-snowy.vercel.app${url}`, init);

describe("api оплаты без ключей", () => {
  it("без входа – 401 с понятной ошибкой", async () => {
    const r = await status.fetch(req("/api/billing/status"));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Войдите в аккаунт" });
  });
  it("CORS: OPTIONS отвечает 204", async () => {
    const r = await pay.fetch(req("/api/billing/pay", { method: "OPTIONS", headers: { origin: "http://localhost:5173" } }));
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
  it("нет ключа Firebase – 503 «оплата не настроена»", async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const r = await pay.fetch(req("/api/billing/pay", { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" }));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/не настроена/);
  });
  it("cron без секрета отклоняется", async () => {
    process.env.CRON_SECRET = "s".repeat(20);
    expect((await cron.fetch(req("/api/cron/charge"))).status).toBe(401);
    expect((await cron.fetch(req("/api/cron/charge", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });
  it("вебхук: не платёж – пропускаем, кривой JSON – 400, неверный номер – 400", async () => {
    expect(await (await webhook.fetch(req("/api/yookassa/webhook", { method: "POST", body: JSON.stringify({ event: "refund.succeeded", object: { id: "x" } }) }))).json()).toEqual({ ok: true, skipped: true });
    expect((await webhook.fetch(req("/api/yookassa/webhook", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await webhook.fetch(req("/api/yookassa/webhook", { method: "POST", body: JSON.stringify({ event: "payment.succeeded", object: { id: "../x" } }) }))).status).toBe(400);
  });
  it("возврат после оплаты только на наши адреса", () => {
    const o = (origin: string) => returnBase(new Request("https://x", { headers: { origin } }));
    expect(o("https://mantis-web-snowy.vercel.app")).toBe("https://mantis-web-snowy.vercel.app");
    expect(o("http://localhost:5173")).toBe("http://localhost:5173");
    expect(o("https://evil.example")).toBe("https://mantis-web-snowy.vercel.app");
  });
});
