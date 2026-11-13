-- Container & Device: inventario de SmartBox y alertas de batería.
-- Idempotente: el servicio lo ejecuta al arrancar.

create table if not exists container_smartboxes (
  box_id          text primary key,
  serial_number   text not null unique,
  mac_address     text not null unique check (mac_address ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  max_weight_kg   numeric not null check (max_weight_kg > 0),
  status          text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'IN_TRANSIT', 'MAINTENANCE', 'DECOMMISSIONED')),
  device_id       text unique,
  battery_level   numeric not null default 100 check (battery_level between 0 and 100),
  is_online       boolean not null default false,
  last_heartbeat  timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists container_alerts (
  alert_id       text primary key,
  type           text not null default 'LOW_BATTERY' check (type in ('LOW_BATTERY')),
  severity       text not null default 'WARNING',
  box_id         text not null references container_smartboxes (box_id) on delete cascade,
  battery_level  numeric,
  resolved       boolean not null default false,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  resolved_at    timestamptz
);
-- Una sola alerta abierta por caja y tipo
create unique index if not exists container_alerts_one_open on container_alerts (box_id, type) where not resolved;

alter table container_smartboxes enable row level security;
alter table container_alerts enable row level security;
