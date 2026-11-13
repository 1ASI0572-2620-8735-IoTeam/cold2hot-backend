-- Access & Security: OTP, cerrojos, bitácora de intentos, eventos de tapa y alertas.
-- Idempotente: el servicio lo ejecuta al arrancar. Los order_id se guardan sin '#'.

create table if not exists security_otps (
  otp_id        text primary key,
  order_id      text not null,
  smart_box_id  text not null,
  code          text not null check (code ~ '^\d{6}$'),
  used          boolean not null default false,
  revoked       boolean not null default false,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);
create index if not exists security_otps_box_code_idx on security_otps (smart_box_id, code);
create index if not exists security_otps_order_idx on security_otps (order_id, created_at desc);

create table if not exists security_locks (
  smart_box_id  text primary key,
  lock_state    text not null default 'LOCKED' check (lock_state in ('LOCKED', 'UNLOCKED')),
  order_id      text,
  updated_at    timestamptz not null default now()
);

create table if not exists security_access_attempts (
  attempt_id    text primary key,
  smart_box_id  text not null,
  order_id      text,
  code_masked   text,
  action        text not null check (action in ('VALIDATE', 'UNLOCK')),
  result        text not null,
  created_at    timestamptz not null default now()
);
create index if not exists security_attempts_order_idx on security_access_attempts (order_id, created_at);
create index if not exists security_attempts_box_idx on security_access_attempts (smart_box_id, created_at);

create table if not exists security_tamper_events (
  event_id         text primary key,
  smart_box_id     text not null,
  order_id         text,
  lid_open         boolean not null,
  package_present  boolean,
  forced           boolean not null default false,
  authorized       boolean,
  created_at       timestamptz not null default now()
);
create index if not exists security_events_order_idx on security_tamper_events (order_id, created_at);
create index if not exists security_events_box_idx on security_tamper_events (smart_box_id, created_at);

create table if not exists security_alerts (
  alert_id      text primary key,
  type          text not null check (type in ('UNAUTHORIZED_ACCESS', 'LID_OPEN')),
  severity      text not null check (severity in ('CRITICAL', 'WARNING', 'INFO')),
  smart_box_id  text not null,
  order_id      text,
  message       text not null,
  resolved      boolean not null default false,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists security_alerts_open_idx on security_alerts (resolved, created_at desc);
create index if not exists security_alerts_order_idx on security_alerts (order_id);

alter table security_otps enable row level security;
alter table security_locks enable row level security;
alter table security_access_attempts enable row level security;
alter table security_tamper_events enable row level security;
alter table security_alerts enable row level security;
