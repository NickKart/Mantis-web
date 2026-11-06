// База оплат в PostgreSQL (store-pg.ts) на живой базе. Запуск:
//   TEST_DATABASE_URL=postgres://user@host:5432/mantis_test npm test
// Без TEST_DATABASE_URL тесты пропускаются. База очищается перед прогоном – не указывайте боевую!

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { YkPayment, YkPaymentMethod } from "../api/_lib/yookassa";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("оплаты в PostgreSQL", () => {
  let s: typeof import("../api/_lib/store-pg");
  let pg: typeof import("pg").default;
  let client: InstanceType<typeof import("pg").default.Client>;

  const payment = (o: Partial<YkPayment> & { id: string; uid: string; value: string; kind?: string }): YkPayment => ({
    id: o.id, status: o.status ?? "succeeded", paid: o.paid ?? (o.status ?? "succeeded") === "succeeded",
    amount: { value: o.value, currency: "RUB" }, created_at: new Date().toISOString(), captured_at: new Date().toISOString(),
    metadata: { uid: o.uid, plan: "start", cameras: "1", period: "month", ...(o.kind ? { kind: o.kind } : {}) },
    cancellation_details: o.cancellation_details, payment_method: o.payment_method, description: "тест", test: true,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    pg = (await import("pg")).default;
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("DROP TABLE IF EXISTS billing_ledger, billing_cards, billing_payments, billing_accounts");
    await client.query(readFileSync("server/schema.sql", "utf8"));
    s = await import("../api/_lib/store-pg");
  });

  afterAll(async () => {
    await s?.closeDb();
    await client?.end();
  });

  it("новый пользователь – пустой счёт", async () => {
    const { account } = await s.getAccount("u-new");
    expect(account).toMatchObject({ balance: 0, plan: null, status: "none", cameras: 1 });
    expect(await s.ledger("u-new")).toEqual([]);
  });

  it("оплата зачисляется один раз и сразу списывает месяц", async () => {
    const sel = { plan: "start" as const, cameras: 1, period: "month" as const };
    const p = payment({ id: "pay-000000000001", uid: "u1", value: "190.00", status: "pending", paid: false });
    await s.savePayment("u1", p, sel, 190_00, "Mantis, тариф «Старт»", "checkout");
    await s.savePayment("u1", p, sel, 190_00, "Mantis, тариф «Старт»", "checkout"); // повтор – без ошибки
    const ok = { ...p, status: "succeeded" as const, paid: true };
    expect(await s.applyPayment(ok)).toBe("credited");
    expect(await s.applyPayment(ok)).toBe("already");
    const { account } = await s.getAccount("u1");
    expect(account).toMatchObject({ balance: 0, plan: "start", status: "active" });
    expect(account.paidUntil! - Date.now()).toBeGreaterThan(27 * 24 * 3600_000);
    const l = await s.ledger("u1");
    expect(l.map((x) => x.type).sort()).toEqual(["charge", "topup"]);
    expect(l.find((x) => x.type === "topup")!.amount).toBe(190_00);
  });

  it("сумма не сходится – не зачисляем", async () => {
    const sel = { plan: "start" as const, cameras: 1, period: "month" as const };
    const p = payment({ id: "pay-000000000002", uid: "u2", value: "1.00" });
    await s.savePayment("u2", { ...p, status: "pending" }, sel, 190_00, "x", "checkout");
    expect(await s.applyPayment(p)).toBe("updated");
    expect((await s.getAccount("u2")).account.balance).toBe(0);
    const { rows } = await client.query("SELECT credited, mismatch FROM billing_payments WHERE id = $1", [p.id]);
    expect(rows[0]).toEqual({ credited: false, mismatch: true });
  });

  it("платёж без нашей записи (пришёл только вебхук) заводится и зачисляется", async () => {
    expect(await s.applyPayment(payment({ id: "pay-000000000003", uid: "u3", value: "190.00" }))).toBe("credited");
    expect((await s.getAccount("u3")).account.status).toBe("active");
  });

  it("пробный период – один раз, почта сохраняется", async () => {
    const a = await s.beginTrial("u4", "vitrina", 2, "u4@example.com");
    expect(a).toMatchObject({ status: "trial", trialUsed: true, plan: "vitrina", cameras: 2 });
    await expect(s.beginTrial("u4", "vitrina", 2, null)).rejects.toThrow(/уже/);
    expect((await s.getAccount("u4")).email).toBe("u4@example.com");
  });

  it("карта для пробного периода: привязка запускает пробный период, повтор – already", async () => {
    const m: YkPaymentMethod = {
      id: "pm-000000000001", type: "bank_card", saved: true, status: "active",
      card: { last4: "4444", card_type: "MasterCard" }, metadata: { uid: "u5", purpose: "trial", plan: "start", cameras: "1" },
    };
    expect(await s.applyPaymentMethod(m)).toBe("saved");
    expect(await s.applyPaymentMethod(m)).toBe("already");
    const { account } = await s.getAccount("u5");
    expect(account).toMatchObject({ status: "trial", card: { id: "pm-000000000001", title: "MasterCard •••• 4444" } });
    expect((await s.unbindCard("u5")).card).toBeNull();
  });

  it("отказ автоплатежа: ошибка в счёте, «мёртвая» карта отвязывается", async () => {
    await client.query("INSERT INTO billing_accounts (uid, plan, card_id, card_title, status) VALUES ('u6', 'start', 'pm-x', '•••• 1111', 'active')");
    const p = payment({
      id: "pay-000000000006", uid: "u6", value: "190.00", status: "canceled", paid: false, kind: "autopay",
      cancellation_details: { party: "issuer", reason: "card_expired" },
    });
    expect(await s.applyPayment(p)).toBe("updated");
    const { account } = await s.getAccount("u6");
    expect(account.card).toBeNull();
    expect(account.autopayError).toMatch(/Не удалось списать 190 ₽/);
  });

  it("ежедневное продление: хватает баланса – продлеваем, автопродление выключено – нет", async () => {
    const past = new Date(Date.now() - 3600_000);
    await client.query("INSERT INTO billing_accounts (uid, plan, balance, paid_until, status) VALUES ('u7', 'start', 50000, $1, 'active')", [past]);
    await client.query("INSERT INTO billing_accounts (uid, plan, balance, paid_until, status, auto_renew) VALUES ('u8', 'start', 50000, $1, 'active', false)", [past]);
    const r = await s.chargeAllDue();
    expect(r).toMatchObject({ renewed: 1, failed: 0 });
    expect((await s.getAccount("u7")).account).toMatchObject({ balance: 50000 - 19000, status: "active" });
    expect((await s.getAccount("u8")).account.balance).toBe(50000);
  });

  it("параллельные зачисления одного платежа – деньги приходят один раз", async () => {
    const p = payment({ id: "pay-000000000009", uid: "u9", value: "190.00" });
    const res = await Promise.all(Array.from({ length: 5 }, () => s.applyPayment(p)));
    expect(res.filter((x) => x === "credited")).toHaveLength(1);
    const { rows } = await client.query("SELECT count(*)::int AS n FROM billing_ledger WHERE uid = 'u9' AND type = 'topup'");
    expect(rows[0].n).toBe(1);
  });
});
