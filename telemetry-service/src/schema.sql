-- Telemetry: perfiles térmicos, lecturas DS18B20 y alertas de desvío térmico.
-- Idempotente: el servicio lo ejecuta al arrancar.

create table if not exists telemetry_profiles (
  profile_id       text primary key,
  order_id         text not null,
  smart_box_id     text not null,
  type             text not null check (type in ('COLD', 'HOT')),
  min_temperature  numeric not null,
  max_temperature  numeric not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  check (min_temperature < max_temperature)
);
create unique index if not exists telemetry_profiles_one_active_per_box on telemetry_profiles (smart_box_id) where active;
create index if not exists telemetry_profiles_order_idx on telemetry_profiles (order_id);

create table if not exists telemetry_readings (
  id            bigint generated always as identity primary key,
  smart_box_id  text not null,
  order_id      text not null,
  temperature   numeric not null,
  lid_open      boolean not null default false,
  in_range      boolean,
  recorded_at   timestamptz not null default now()
);
create index if not exists telemetry_readings_box_idx on telemetry_readings (smart_box_id, recorded_at desc);
create index if not exists telemetry_readings_order_idx on telemetry_readings (order_id, recorded_at desc);

create table if not exists telemetry_alerts (
  alert_id               text primary key,
  type                   text not null default 'THERMAL_BREACH',
  severity               text not null,
  order_id               text not null,
  smart_box_id           text not null,
  temperature            numeric,
  min_temperature        numeric,
  max_temperature        numeric,
  message                text,
  readings_out_of_range  integer not null default 1,
  resolved               boolean not null default false,
  created_at             timestamptz not null default now(),
  last_seen_at           timestamptz,
  resolved_at            timestamptz
);
create unique index if not exists telemetry_alerts_one_open_per_order on telemetry_alerts (order_id) where type = 'THERMAL_BREACH' and not resolved;
create index if not exists telemetry_alerts_created_idx on telemetry_alerts (created_at desc);

alter table telemetry_profiles enable row level security;
alter table telemetry_readings enable row level security;
alter table telemetry_alerts enable row level security;
