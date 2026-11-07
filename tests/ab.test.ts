// A/B-тест веб-версии: статистика, проверка запросов, закрепление варианта и отчёт на живой PostgreSQL.
//   TEST_DATABASE_URL=postgres://user@host:5432/mantis_test npm test
// Без TEST_DATABASE_URL тесты базы пропускаются. Таблицы создаются в отдельной схеме abtest и очищаются перед прогоном.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AB_CONFIG } from "../ab/events";
import { eventHandler, probABetter } from "../server/ab";

const url = process.env.TEST_DATABASE_URL;

/** Детерминированный генератор для проверки вероятностей. */
function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 2 ** 32;
  };
}

describe("вероятность, что A лучше B", () => {
  it("явный перевес, равенство, нет данных", () => {
    expect(probABetter(50, 100, 10, 100, 20_000, rng())!).toBeGreaterThan(0.99);
    expect(probABetter(10, 100, 50, 100, 20_000, rng())!).toBeLessThan(0.01);
    expect(Math.abs(probABetter(30, 100, 30, 100, 20_000, rng())! - 0.5)).toBeLessThan(0.03);
    expect(probABetter(0, 0, 1, 10)).toBeNull();
  });
});

describe("проверка запросов событий", () => {
  const post = (b: unknown) => eventHandler.fetch(new Request("https://mantis.rcmit.ru/api/ab/event", { method: "POST", body: JSON.stringify(b) }));
  const ok = { experiment: AB_CONFIG.experiment, variant: "a", vid: "abc123def", test: false, events: [] };
  it("чужой эксперимент, вариант и посетитель отклоняются", async () => {
    expect((await post({ ...ok, experiment: "old" })).status).toBe(409);
    expect((await post({ ...ok, variant: "c" })).status).toBe(400);
    expect((await post({ ...ok, vid: "../x" })).status).toBe(400);
    expect((await post({ ...ok, events: undefined })).status).toBe(400);
  });
});

describe("скрипт выбора варианта (ab/gate.js)", () => {
  const code = readFileSync("ab/gate.js", "utf8");
  function run(o: { me: "a" | "b"; href: string; cookie?: string; random?: number; config?: Partial<typeof AB_CONFIG> }) {
    const jar = new Map<string, string>();
    for (const p of (o.cookie ?? "").split("; ").filter(Boolean)) jar.set(p.split("=")[0], p.split("=")[1]);
    const u = new URL(o.href);
    let replaced: string | null = null;
    const ctx = {
      URL,
      Math: Object.assign(Object.create(Math), { random: () => o.random ?? 0.1 }),
      Date,
      encodeURIComponent,
      decodeURIComponent,
      RegExp,
      location: {
        href: o.href, hostname: u.hostname, protocol: u.protocol,
        replace: (x: string) => { replaced = x; },
      },
      history: { state: null, replaceState: (_s: unknown, _t: string, x: string) => { ctx.location.href = new URL(x, o.href).href; } },
      document: {
        get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
        set cookie(s: string) {
          const [kv] = s.split("; ");
          const [k, v] = kv.split("=");
          if (/max-age=0/.test(s)) jar.delete(k);
          else jar.set(k, v);
        },
      },
      window: {} as { __mantisAB?: { variant: string; running: boolean; test: boolean } },
    };
    const src = code.replace("__AB_CONFIG__", JSON.stringify({ ...AB_CONFIG, ...o.config })).replace("__AB_ME__", JSON.stringify(o.me));
    runInNewContext(src, ctx);
    return { replaced, jar, ab: ctx.window.__mantisAB! };
  }

  it("новый посетитель на A получает B и уходит на /b/ с параметрами", () => {
    const r = run({ me: "a", href: "https://mantis.rcmit.ru/?payment=return#/live", random: 0.2 });
    expect(r.jar.get("mantis_v")).toBe("b");
    expect(r.replaced).toBe("/b/?payment=return#/live");
  });
  it("свой вариант – остаёмся, cookie посетителя есть", () => {
    const r = run({ me: "a", href: "https://mantis.rcmit.ru/", random: 0.9 });
    expect(r.jar.get("mantis_v")).toBe("a");
    expect(r.replaced).toBeNull();
    expect(r.jar.get("mantis_vid")).toMatch(/^[a-z0-9]{6,40}$/);
    expect(r.ab).toMatchObject({ variant: "a", running: true, test: false });
  });
  it("вариант из cookie сохраняется: B на корне уходит на /b/, на /b/ остаётся", () => {
    expect(run({ me: "a", href: "https://mantis.rcmit.ru/", cookie: "mantis_v=b", random: 0.9 }).replaced).toBe("/b/");
    expect(run({ me: "b", href: "https://mantis.rcmit.ru/b/", cookie: "mantis_v=b", random: 0.9 }).replaced).toBeNull();
    expect(run({ me: "b", href: "https://mantis.rcmit.ru/b/", cookie: "mantis_v=a" }).replaced).toBe("/");
  });
  it("?ab=b помечает браузер тестовым и переводит на B, ?ab=off снимает пометку", () => {
    const r = run({ me: "a", href: "https://mantis.rcmit.ru/?ab=b", cookie: "mantis_v=a" });
    expect(r.jar.get("mantis_ab_test")).toBe("1");
    expect(r.replaced).toBe("/b/");
    expect(run({ me: "a", href: "https://mantis.rcmit.ru/?ab=off", cookie: "mantis_v=a; mantis_ab_test=1" }).jar.has("mantis_ab_test")).toBe(false);
  });
  it("на других адресах (Vercel) без ?ab= ничего не делает, с ?ab=b – переводит", () => {
    const r = run({ me: "a", href: "https://mantis-web-snowy.vercel.app/", random: 0.2 });
    expect(r.replaced).toBeNull();
    expect(r.jar.has("mantis_v")).toBe(false);
    expect(r.ab.running).toBe(false);
    expect(run({ me: "a", href: "https://mantis-web-snowy.vercel.app/?ab=b" }).replaced).toBe("/b/");
  });
  it("тест остановлен – все на победителя; force – все на один вариант", () => {
    expect(run({ me: "b", href: "https://mantis.rcmit.ru/b/", cookie: "mantis_v=b", config: { active: false, winner: "a" } }).replaced).toBe("/");
    expect(run({ me: "b", href: "https://mantis.rcmit.ru/b/", cookie: "mantis_v=b", config: { force: "a" } }).replaced).toBe("/");
  });
  it("cookie не сохраняются – без перенаправления", () => {
    const code2 = code.replace("document.cookie = ", "void ");
    const ctx = {
      URL, Math: Object.assign(Object.create(Math), { random: () => 0.1 }), Date, encodeURIComponent, decodeURIComponent, RegExp,
      location: { href: "https://mantis.rcmit.ru/", hostname: "mantis.rcmit.ru", protocol: "https:", replace: () => { throw new Error("перенаправил"); } },
      history: { state: null, replaceState: () => undefined },
      document: { cookie: "" },
      window: {},
    };
    runInNewContext(code2.replace("__AB_CONFIG__", JSON.stringify(AB_CONFIG)).replace("__AB_ME__", '"a"'), ctx);
  });
});

describe.skipIf(!url)("A/B в PostgreSQL", () => {
  let ab: typeof import("../server/ab");
  let pg: typeof import("pg").default;
  let client: InstanceType<typeof import("pg").default.Client>;
  const exp = AB_CONFIG.experiment;

  beforeAll(async () => {
    pg = (await import("pg")).default;
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS abtest CASCADE; CREATE SCHEMA abtest");
    await client.query("SET search_path TO abtest");
    await client.query(readFileSync("server/schema.sql", "utf8"));
    const u = new URL(url!);
    u.searchParams.set("options", "-c search_path=abtest");
    process.env.DATABASE_URL = u.toString();
    process.env.AB_EXCLUDE = "team@rcmit.ru";
    ab = await import("../server/ab");
  });

  afterAll(async () => {
    await ab?.closeAbDb();
    await client?.query("DROP SCHEMA IF EXISTS abtest CASCADE");
    await client?.end();
  });

  it("вариант закрепляется за аккаунтом при первом входе", async () => {
    expect(await ab.assign({ uid: "u1", email: "u1@x.ru", variant: "b", vid: "vid00001", test: false })).toEqual({ variant: "b", test: false });
    // вошёл с другого браузера, где выпал A, – всё равно B
    expect(await ab.assign({ uid: "u1", email: "u1@x.ru", variant: "a", vid: "vid00002", test: false })).toEqual({ variant: "b", test: false });
  });

  it("тестовые аккаунты: вариант – текущий, пометка остаётся навсегда", async () => {
    expect(await ab.assign({ uid: "t1", email: null, variant: "a", vid: "vid00003", test: true })).toEqual({ variant: "a", test: true });
    expect(await ab.assign({ uid: "t1", email: null, variant: "b", vid: "vid00003", test: false })).toEqual({ variant: "b", test: true });
    expect(await ab.assign({ uid: "t2", email: "Team@rcmit.ru", variant: "a", vid: "vid00004", test: false })).toEqual({ variant: "a", test: true });
  });

  it("события до входа привязываются к аккаунту, лишние отбрасываются", async () => {
    const n = await ab.saveEvents({
      uid: null, variant: "a", vid: "vid00010", test: false,
      events: [{ name: "session_start" }, { name: "hack" }, { name: "screen_view", data: { screen: "live" } }, { name: "error", data: { big: "x".repeat(5000) } }],
    });
    expect(n).toBe(3);
    await ab.assign({ uid: "u2", email: null, variant: "a", vid: "vid00010", test: false });
    const { rows } = await client.query("SELECT name, uid, data FROM abtest.ab_events WHERE vid = 'vid00010' ORDER BY id");
    expect(rows.map((r) => r.name)).toEqual(["session_start", "screen_view", "error"]);
    expect(rows.every((r) => r.uid === "u2")).toBe(true);
    expect(rows[1].data).toEqual({ screen: "live" });
    expect(rows[2].data).toBeNull();
  });

  it("отчёт: активация, возврат, оплаты, тестовые не считаются", async () => {
    await client.query("TRUNCATE abtest.ab_events, abtest.ab_assignments");
    const days = AB_CONFIG.activationDays;
    // A: 4 аккаунта старше срока, 3 активировались вовремя, 1 – поздно; ещё 1 молодой. B: 4 старых, 1 активировался.
    const acc = async (uid: string, variant: "a" | "b", ageDays: number, test = false) => {
      await ab.assign({ uid, email: null, variant, vid: `v${uid}0000`, test });
      await client.query("UPDATE abtest.ab_assignments SET assigned_at = now() - make_interval(days => $2) WHERE uid = $1", [uid, ageDays]);
    };
    const ev = async (uid: string, variant: "a" | "b", name: string, atDaysAgo: number, data?: object) => {
      await client.query(
        "INSERT INTO abtest.ab_events (experiment, variant, uid, vid, name, data, at) VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7))",
        [exp, variant, uid, `v${uid}0000`, name, data ? JSON.stringify(data) : null, atDaysAgo],
      );
    };
    for (const u of ["a1", "a2", "a3", "a4"]) await acc(u, "a", days + 5);
    await acc("a5", "a", 1);
    for (const u of ["b1", "b2", "b3", "b4"]) await acc(u, "b", days + 5);
    await acc("bt", "b", days + 5, true);
    for (const u of ["a1", "a2", "a3"]) await ev(u, "a", "hours_saved", days + 4, { passed: 12 });
    await ev("a4", "a", "hours_saved", 1, { passed: 3 }); // поздно
    await ev("a5", "a", "hours_saved", 0, { passed: 5 }); // молодой
    await ev("b1", "b", "hours_saved", days + 4, { passed: 7 });
    await ev("b2", "b", "hours_saved", days + 4, { passed: 0 }); // подсчёт без людей – не активация
    await ev("bt", "b", "hours_saved", days + 4, { passed: 9 }); // тестовый
    await ev("a1", "a", "session_start", 1);
    await ev("b1", "b", "session_start", days + 5);
    await ev("a1", "a", "signup", days + 5);
    await client.query("INSERT INTO abtest.billing_accounts (uid) VALUES ('a1'), ('b1')");
    await client.query(`INSERT INTO abtest.billing_payments (id, uid, amount, kind, status, credited, test) VALUES
      ('p1', 'a1', 19000, 'checkout', 'succeeded', true, false), ('p2', 'b1', 45000, 'checkout', 'succeeded', true, true)`);
    await client.query(`INSERT INTO abtest.billing_ledger (id, uid, type, amount, balance_after, at) VALUES ('l1', 'b1', 'trial', 0, 0, now())`);

    const r = await ab.report();
    expect(r.variants.a).toMatchObject({ accounts: 5, matured: 4, activated: 3, countedEver: 5, returned: 1, signups: 1, paid: 1, revenue: 190, trials: 0 });
    expect(r.variants.b).toMatchObject({ accounts: 4, matured: 4, activated: 1, countedEver: 1, returned: 0, paid: 0, revenue: 0, trials: 1 });
    expect(r.pABetter.activation!).toBeGreaterThan(0.8);
    expect(ab.reportText(r)).toContain("Активация за 7 дн.");
  });
});
