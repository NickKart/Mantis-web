-- База оплат Mantis (PostgreSQL). Применяется при каждом деплое – повторный запуск ничего не ломает.
-- Суммы – в копейках, даты – timestamptz. Пишет только сервер API (server/index.ts).

CREATE TABLE IF NOT EXISTS billing_accounts (
  uid           text PRIMARY KEY,               -- uid пользователя Firebase
  email         text,                           -- почта для чеков 54-ФЗ
  balance       bigint      NOT NULL DEFAULT 0,
  plan          text,                           -- start | vitrina | set
  cameras       integer     NOT NULL DEFAULT 1,
  annual_until  timestamptz,                    -- до какого момента списания по годовой цене
  paid_until    timestamptz,                    -- до какого момента подписка оплачена
  status        text        NOT NULL DEFAULT 'none', -- none | trial | active | expired
  trial_used    boolean     NOT NULL DEFAULT false,
  auto_renew    boolean     NOT NULL DEFAULT true,
  card_id       text,                           -- способ оплаты ЮKassa для автоплатежей
  card_title    text,
  autopay_error text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_accounts_due ON billing_accounts (paid_until) WHERE auto_renew AND plan IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_payments (
  id          text PRIMARY KEY,                 -- номер платежа в ЮKassa
  uid         text        NOT NULL REFERENCES billing_accounts (uid),
  amount      bigint      NOT NULL,
  plan        text,
  cameras     integer,
  period      text,                             -- month | year
  description text        NOT NULL DEFAULT '',
  kind        text        NOT NULL,             -- checkout | autopay
  status      text        NOT NULL,             -- pending | waiting_for_capture | succeeded | canceled
  credited    boolean     NOT NULL DEFAULT false,
  mismatch    boolean     NOT NULL DEFAULT false,
  expired     boolean     NOT NULL DEFAULT false,
  test        boolean     NOT NULL DEFAULT false,
  cancel      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz
);

CREATE INDEX IF NOT EXISTS billing_payments_uid_status ON billing_payments (uid, status);

CREATE TABLE IF NOT EXISTS billing_cards (
  id           text PRIMARY KEY,                -- номер способа оплаты в ЮKassa
  uid          text        NOT NULL REFERENCES billing_accounts (uid),
  status       text        NOT NULL,            -- pending | active | inactive
  purpose      text,                            -- trial | bind
  plan         text,
  cameras      integer,
  title        text,
  expired      boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE INDEX IF NOT EXISTS billing_cards_uid_status ON billing_cards (uid, status);

CREATE TABLE IF NOT EXISTS billing_ledger (
  id            text PRIMARY KEY,               -- pay_<номер платежа> для зачислений, иначе uuid
  uid           text        NOT NULL REFERENCES billing_accounts (uid),
  type          text        NOT NULL,           -- topup | charge | trial
  amount        bigint      NOT NULL,           -- + зачисление, − списание
  balance_after bigint      NOT NULL,
  at            timestamptz NOT NULL,
  plan          text,
  cameras       integer,
  from_at       timestamptz,
  to_at         timestamptz,
  annual        boolean,
  payment_id    text,
  note          text        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS billing_ledger_uid_at ON billing_ledger (uid, at DESC);

-- ---------------------------------------------------------------- A/B-тест веб-версии (server/ab.ts, docs/ab-test.md)
-- Вариант закрепляется за аккаунтом при первом входе: a – новая версия, b – старая (/b/).
CREATE TABLE IF NOT EXISTS ab_assignments (
  experiment   text        NOT NULL,
  uid          text        NOT NULL,            -- uid пользователя Firebase
  variant      text        NOT NULL CHECK (variant IN ('a', 'b')),
  test         boolean     NOT NULL DEFAULT false, -- команда (?ab=, AB_EXCLUDE) – в статистику не идёт
  vid          text,                            -- браузер, в котором вошёл впервые (cookie mantis_vid)
  email        text,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment, uid)
);

CREATE TABLE IF NOT EXISTS ab_events (
  id         bigserial   PRIMARY KEY,
  experiment text        NOT NULL,
  variant    text        NOT NULL CHECK (variant IN ('a', 'b')),
  uid        text,                              -- пусто, пока посетитель не вошёл
  vid        text        NOT NULL,
  test       boolean     NOT NULL DEFAULT false,
  name       text        NOT NULL,              -- список – ab/events.ts
  data       jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ab_events_exp_name ON ab_events (experiment, name, at);
CREATE INDEX IF NOT EXISTS ab_events_uid ON ab_events (uid) WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS ab_events_vid ON ab_events (vid);
