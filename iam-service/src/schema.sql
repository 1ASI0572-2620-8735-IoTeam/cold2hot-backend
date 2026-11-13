-- IAM & Subscriptions: restaurantes, suscripción, usuarios, operadores y recuperación de contraseña.
-- Idempotente: el servicio lo ejecuta al arrancar.

create table if not exists iam_restaurants (
  restaurant_id         text primary key,
  name                  text not null,
  ruc                   text check (ruc ~ '^\d{11}$'),
  phone                 text,
  address               text,
  cold_min_temperature  numeric not null default 0,
  cold_max_temperature  numeric not null default 8,
  hot_min_temperature   numeric not null default 55,
  hot_max_temperature   numeric not null default 75,
  notify_email          boolean not null default true,
  notify_push           boolean not null default true,
  notify_critical_only  boolean not null default false,
  created_at            timestamptz not null default now(),
  check (cold_min_temperature < cold_max_temperature),
  check (hot_min_temperature < hot_max_temperature)
);

create table if not exists iam_subscriptions (
  restaurant_id  text primary key references iam_restaurants (restaurant_id) on delete cascade,
  plan           text not null check (plan in ('STARTER', 'PRO', 'ENTERPRISE')),
  status         text not null check (status in ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED')),
  payment_brand  text,
  payment_last4  text check (payment_last4 ~ '^\d{4}$'),
  started_at     timestamptz not null default now(),
  renews_at      timestamptz
);

create table if not exists iam_users (
  user_id        text primary key,
  restaurant_id  text not null references iam_restaurants (restaurant_id) on delete cascade,
  email          text not null unique,
  password_hash  text not null,
  name           text not null,
  role           text not null default 'ADMINISTRATOR',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz
);
create index if not exists iam_users_restaurant_idx on iam_users (restaurant_id);

create table if not exists iam_operators (
  operator_id           text primary key,
  restaurant_id         text not null references iam_restaurants (restaurant_id) on delete cascade,
  name                  text not null,
  email                 text not null unique,
  phone                 text,
  status                text not null default 'INVITED' check (status in ('ACTIVE', 'INVITED', 'INACTIVE')),
  completed_deliveries  integer not null default 0,
  custody_rating        numeric(2, 1),
  invited_at            timestamptz not null default now(),
  updated_at            timestamptz
);
create index if not exists iam_operators_restaurant_idx on iam_operators (restaurant_id, status);

-- Solo se guarda el hash SHA-256 del token de recuperación
create table if not exists iam_password_resets (
  token_hash  text primary key,
  user_id     text not null unique references iam_users (user_id) on delete cascade,
  expires_at  timestamptz not null
);

alter table iam_restaurants enable row level security;
alter table iam_subscriptions enable row level security;
alter table iam_users enable row level security;
alter table iam_operators enable row level security;
alter table iam_password_resets enable row level security;
