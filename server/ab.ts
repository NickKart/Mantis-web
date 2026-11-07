// A/B-тест веб-версии на своём сервере (mantis.rcmit.ru): закрепление варианта, события, отчёт.
// Таблицы – ab_assignments и ab_events в server/schema.sql, список событий и настройки – ab/events.ts, ab/config.json.
//
//   POST /api/ab/assign  {experiment, variant, vid, test} + вход   → {variant, test}  – вариант аккаунта
//   POST /api/ab/event   {experiment, variant, vid, test, events}   → {ok}             – события (вход не обязателен)
//   GET  /api/ab/report  + вход с почтой из AB_ADMINS               → отчёт по вариантам
//   node server.cjs ab-report                                       → тот же отчёт в консоль
//
// Переменные окружения: AB_ADMINS – почты, которым виден отчёт; AB_EXCLUDE – почты команды (их аккаунты не считаются).

import pg from "pg";
import { AB_CONFIG, isAbEvent } from "../ab/events.js";
import { HttpError, body, caller, handler, json } from "../api/_lib/server.js";

type Variant = "a" | "b";
const isVariant = (v: unknown): v is Variant => v === "a" || v === "b";
const VID = /^[a-z0-9]{6,40}$/;
const MAX_EVENTS = 50;
const MAX_DATA = 2000;

let pool: pg.Pool | null = null;

function db(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(503, "Нет базы на сервере");
  pool = new pg.Pool({ connectionString: url, max: 3 });
  pool.on("error", (e) => console.error("postgres ab", e));
  return pool;
}

export async function closeAbDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

const emails = (name: string): string[] =>
  (process.env[name] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Тест идёт: включён и не принудительно на одном варианте. */
export const abRunning = (): boolean => AB_CONFIG.active && !AB_CONFIG.force;

// ---------------------------------------------------------------- закрепление варианта

/** Вариант аккаунта: при первом входе – тот, что выпал браузеру; дальше – всегда он же. Тестовым – текущий. */
export async function assign(o: { uid: string; email: string | null; variant: Variant; vid: string | null; test: boolean }): Promise<{ variant: Variant; test: boolean }> {
  const test = o.test || (!!o.email && emails("AB_EXCLUDE").includes(o.email.toLowerCase()));
  const q = db();
  const { rows } = await q.query(
    `INSERT INTO ab_assignments (experiment, uid, variant, test, vid, email) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (experiment, uid) DO UPDATE SET
       last_seen_at = now(),
       test = ab_assignments.test OR EXCLUDED.test,
       variant = CASE WHEN ab_assignments.test OR EXCLUDED.test THEN EXCLUDED.variant ELSE ab_assignments.variant END,
       email = COALESCE(EXCLUDED.email, ab_assignments.email)
     RETURNING variant, test`,
    [AB_CONFIG.experiment, o.uid, o.variant, test, o.vid, o.email],
  );
  // события этого браузера до входа – тоже этого аккаунта
  if (o.vid) {
    await q.query("UPDATE ab_events SET uid = $2 WHERE experiment = $3 AND vid = $1 AND uid IS NULL", [o.vid, o.uid, AB_CONFIG.experiment]);
  }
  return { variant: rows[0].variant as Variant, test: rows[0].test as boolean };
}

// ---------------------------------------------------------------- события

interface EventIn { name: string; data?: unknown }

/** Не больше LIMIT событий в минуту с одного адреса – защита от мусора (события принимаются без входа). */
const LIMIT = 300;
const hits = new Map<string, { n: number; until: number }>();
function allow(ip: string, n: number): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.until < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { n, until: now + 60_000 });
    return n <= LIMIT;
  }
  h.n += n;
  return h.n <= LIMIT;
}

export async function saveEvents(o: { uid: string | null; variant: Variant; vid: string; test: boolean; events: EventIn[] }): Promise<number> {
  const ok = o.events.filter((e) => isAbEvent(e.name)).slice(0, MAX_EVENTS);
  if (!ok.length) return 0;
  const values: unknown[] = [];
  const rows = ok.map((e, i) => {
    let data: string | null = null;
    if (e.data && typeof e.data === "object") {
      const s = JSON.stringify(e.data);
      if (s.length <= MAX_DATA) data = s;
    }
    values.push(AB_CONFIG.experiment, o.variant, o.uid, o.vid, o.test, e.name, data);
    const b = i * 7;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb)`;
  });
  await db().query(`INSERT INTO ab_events (experiment, variant, uid, vid, test, name, data) VALUES ${rows.join(", ")}`, values);
  return ok.length;
}

// ---------------------------------------------------------------- отчёт

export interface VariantStats {
  /** браузеры, открывшие эту версию */
  visitors: number;
  /** аккаунты, закреплённые за вариантом */
  accounts: number;
  /** зарегистрировались в этой версии */
  signups: number;
  /** аккаунты старше activationDays – по ним считаем активацию и возврат */
  matured: number;
  /** из них подсчёт реально шёл в первые activationDays дней */
  activated: number;
  /** подсчёт шёл хоть раз (все аккаунты, включая молодые) */
  countedEver: number;
  /** вернулись через activationDays+ дней (из matured) */
  returned: number;
  /** начали пробный период */
  trials: number;
  /** оплатили (зачисленные платежи, не тестовые) */
  paid: number;
  /** сумма оплат, ₽ */
  revenue: number;
}

export interface AbReport {
  experiment: string;
  running: boolean;
  config: typeof AB_CONFIG;
  generatedAt: string;
  since: string | null;
  variants: Record<Variant, VariantStats>;
  /** вероятность, что A лучше B (байесовская оценка, равномерный априор) */
  pABetter: { signup: number | null; activation: number | null; paid: number | null };
}

const empty = (): VariantStats => ({
  visitors: 0, accounts: 0, signups: 0, matured: 0, activated: 0, countedEver: 0, returned: 0, trials: 0, paid: 0, revenue: 0,
});

export async function report(): Promise<AbReport> {
  const q = db();
  const exp = AB_CONFIG.experiment;
  const days = AB_CONFIG.activationDays;
  const v: Record<Variant, VariantStats> = { a: empty(), b: empty() };
  const put = (rows: Record<string, unknown>[], f: (s: VariantStats, r: Record<string, unknown>) => void) => {
    for (const r of rows) if (isVariant(r.variant)) f(v[r.variant], r);
  };

  put((await q.query(
    `SELECT variant, count(DISTINCT vid)::int AS n FROM ab_events
     WHERE experiment = $1 AND name = 'session_start' AND NOT test
       AND (uid IS NULL OR uid NOT IN (SELECT uid FROM ab_assignments WHERE experiment = $1 AND test))
     GROUP BY variant`, [exp])).rows, (s, r) => { s.visitors = Number(r.n); });

  put((await q.query(
    `WITH a AS (SELECT * FROM ab_assignments WHERE experiment = $1 AND NOT test)
     SELECT a.variant,
       count(*)::int AS accounts,
       count(*) FILTER (WHERE a.assigned_at <= now() - make_interval(days => $2))::int AS matured,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ab_events e WHERE e.experiment = $1 AND e.uid = a.uid AND e.name = 'signup'))::int AS signups,
       count(*) FILTER (WHERE a.assigned_at <= now() - make_interval(days => $2) AND EXISTS (
         SELECT 1 FROM ab_events e WHERE e.experiment = $1 AND e.uid = a.uid AND e.name = 'hours_saved'
           AND COALESCE((e.data->>'passed')::numeric, 0) > 0 AND e.at < a.assigned_at + make_interval(days => $2)))::int AS activated,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM ab_events e WHERE e.experiment = $1 AND e.uid = a.uid AND e.name = 'hours_saved'
           AND COALESCE((e.data->>'passed')::numeric, 0) > 0))::int AS counted,
       count(*) FILTER (WHERE a.assigned_at <= now() - make_interval(days => $2) AND EXISTS (
         SELECT 1 FROM ab_events e WHERE e.experiment = $1 AND e.uid = a.uid AND e.name = 'session_start'
           AND e.at >= a.assigned_at + make_interval(days => $2)))::int AS returned,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM billing_ledger l WHERE l.uid = a.uid AND l.type = 'trial'))::int AS trials,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM billing_payments p WHERE p.uid = a.uid AND p.credited AND NOT p.test))::int AS paid,
       COALESCE(sum((SELECT sum(p.amount) FROM billing_payments p WHERE p.uid = a.uid AND p.credited AND NOT p.test)), 0)::bigint AS revenue
     FROM a GROUP BY a.variant`, [exp, days])).rows, (s, r) => {
    s.accounts = Number(r.accounts);
    s.matured = Number(r.matured);
    s.signups = Number(r.signups);
    s.activated = Number(r.activated);
    s.countedEver = Number(r.counted);
    s.returned = Number(r.returned);
    s.trials = Number(r.trials);
    s.paid = Number(r.paid);
    s.revenue = Number(r.revenue) / 100;
  });

  const since = (await q.query("SELECT min(at) AS t FROM ab_events WHERE experiment = $1 AND NOT test", [exp])).rows[0]?.t as Date | null;

  return {
    experiment: exp,
    running: abRunning(),
    config: AB_CONFIG,
    generatedAt: new Date().toISOString(),
    since: since ? new Date(since).toISOString() : null,
    variants: v,
    pABetter: {
      signup: probABetter(v.a.signups, v.a.visitors, v.b.signups, v.b.visitors),
      activation: probABetter(v.a.activated, v.a.matured, v.b.activated, v.b.matured),
      paid: probABetter(v.a.paid, v.a.accounts, v.b.paid, v.b.accounts),
    },
  };
}

// ---------------------------------------------------------------- статистика

/** P(доля A > доля B) при априорном Beta(1,1): методом Монте-Карло. null – данных нет совсем. */
export function probABetter(xa: number, na: number, xb: number, nb: number, draws = 40_000, rnd: () => number = Math.random): number | null {
  if (na <= 0 || nb <= 0) return null;
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    if (beta(1 + xa, 1 + na - xa, rnd) > beta(1 + xb, 1 + nb - xb, rnd)) wins++;
  }
  return Math.round((wins / draws) * 1000) / 1000;
}

function beta(a: number, b: number, rnd: () => number): number {
  const x = gamma(a, rnd);
  return x / (x + gamma(b, rnd));
}

/** Гамма-распределение (Marsaglia–Tsang), shape ≥ 1 у нас всегда. */
function gamma(k: number, rnd: () => number): number {
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rnd);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normal(rnd: () => number): number {
  const u = 1 - rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

// ---------------------------------------------------------------- текстовый отчёт (консоль)

const pct = (x: number, n: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : "–");
const prob = (p: number | null) => (p == null ? "мало данных" : `${Math.round(p * 100)}%`);

export function reportText(r: AbReport): string {
  const { a, b } = r.variants;
  const d = r.config.activationDays;
  const row = (label: string, fa: string, fb: string) => `${label.padEnd(36)}${fa.padStart(14)}${fb.padStart(14)}`;
  return [
    `A/B-тест «${r.experiment}» – ${r.running ? "идёт" : "остановлен"}, данные с ${r.since ? r.since.slice(0, 10) : "–"}`,
    row("", "A (новая)", "B (старая)"),
    row("Посетители", String(a.visitors), String(b.visitors)),
    row("Аккаунты", String(a.accounts), String(b.accounts)),
    row("Регистрации (от посетителей)", `${a.signups} · ${pct(a.signups, a.visitors)}`, `${b.signups} · ${pct(b.signups, b.visitors)}`),
    row(`Аккаунтов старше ${d} дн.`, String(a.matured), String(b.matured)),
    row(`Активация за ${d} дн.`, `${a.activated} · ${pct(a.activated, a.matured)}`, `${b.activated} · ${pct(b.activated, b.matured)}`),
    row(`Вернулись через ${d}+ дн.`, `${a.returned} · ${pct(a.returned, a.matured)}`, `${b.returned} · ${pct(b.returned, b.matured)}`),
    row("Подсчёт шёл хоть раз", String(a.countedEver), String(b.countedEver)),
    row("Пробный период", String(a.trials), String(b.trials)),
    row("Оплатили", `${a.paid} · ${pct(a.paid, a.accounts)}`, `${b.paid} · ${pct(b.paid, b.accounts)}`),
    row("Выручка, ₽", a.revenue.toFixed(0), b.revenue.toFixed(0)),
    "",
    `Вероятность, что A лучше B: регистрация ${prob(r.pABetter.signup)}, активация ${prob(r.pABetter.activation)}, оплата ${prob(r.pABetter.paid)}`,
  ].join("\n");
}

// ---------------------------------------------------------------- обработчики

interface AssignIn { experiment: string; variant: string; vid: string; test: boolean }
interface EventsIn { experiment: string; variant: string; vid: string; test: boolean; events: EventIn[] }

function checkCommon(b: Partial<{ experiment: string; variant: string; vid: string }>): { variant: Variant; vid: string } {
  if (b.experiment !== AB_CONFIG.experiment) throw new HttpError(409, "Другой эксперимент");
  if (!isVariant(b.variant)) throw new HttpError(400, "Неверный вариант");
  if (typeof b.vid !== "string" || !VID.test(b.vid)) throw new HttpError(400, "Неверный посетитель");
  return { variant: b.variant, vid: b.vid };
}

export const assignHandler = handler(["POST"], async (req) => {
  const me = await caller(req);
  const b = await body<AssignIn>(req);
  const { variant, vid } = checkCommon(b);
  if (!abRunning()) return json(req, { variant, test: !!b.test, running: false });
  return json(req, { ...(await assign({ uid: me.uid, email: me.email, variant, vid, test: b.test === true })), running: true });
});

export const eventHandler = handler(["POST"], async (req) => {
  const b = await body<EventsIn>(req);
  const { variant, vid } = checkCommon(b);
  if (!Array.isArray(b.events)) throw new HttpError(400, "Нет событий");
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
  if (!allow(ip, b.events.length)) throw new HttpError(429, "Слишком много событий");
  // вход не обязателен: посетитель ещё не вошёл – события по браузеру, потом привяжутся к аккаунту
  const me = req.headers.get("authorization") ? await caller(req).catch(() => null) : null;
  const n = await saveEvents({ uid: me?.uid ?? null, variant, vid, test: b.test === true, events: b.events });
  return json(req, { ok: true, saved: n });
});

export const reportHandler = handler(["GET"], async (req) => {
  const me = await caller(req);
  const admins = emails("AB_ADMINS");
  if (!admins.length) throw new HttpError(403, "Отчёт закрыт: добавьте свою почту в AB_ADMINS в /etc/mantis/mantis.env и перезапустите mantis-api");
  if (!me.email || !admins.includes(me.email.toLowerCase())) throw new HttpError(403, "Отчёт доступен только администраторам");
  return json(req, await report());
});
