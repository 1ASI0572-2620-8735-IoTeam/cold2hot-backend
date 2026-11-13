-- Orders & Audit: envíos, evidencia de entrega y reportes de auditoría.
-- Idempotente: el servicio lo ejecuta al arrancar.

create table if not exists orders (
  order_id          text primary key,
  customer_name     text not null,
  delivery_address  text not null,
  smart_box_id      text not null,
  operator_id       text not null,
  operator_name     text not null,
  thermal_type      text not null check (thermal_type in ('COLD', 'HOT')),
  min_temperature   numeric not null,
  max_temperature   numeric not null,
  status            text not null default 'IN_TRANSIT' check (status in ('CREATED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED')),
  incidents         text[] not null default '{}',
  created_at        timestamptz not null default now(),
  delivered_at      timestamptz,
  check (min_temperature < max_temperature)
);
-- Una SmartBox solo puede tener un envío en curso
create unique index if not exists orders_one_active_per_box on orders (smart_box_id) where status in ('CREATED', 'IN_TRANSIT');
create index if not exists orders_created_idx on orders (created_at desc);
create index if not exists orders_operator_idx on orders (operator_id, delivered_at);

-- Foto de entrega. La imagen vive en Supabase Storage (storage_path / photo_url);
-- photo_base64 solo se usa si el Storage no está configurado.
create table if not exists orders_evidence (
  order_id      text primary key references orders (order_id) on delete cascade,
  photo_url     text,
  storage_path  text,
  photo_base64  text,
  content_type  text,
  size_bytes    integer,
  uploaded_at   timestamptz not null default now(),
  check (photo_url is not null or photo_base64 is not null)
);

-- Reporte de auditoría consolidado: copia inmutable del reporte con su hash de integridad
create table if not exists orders_audit_reports (
  report_id       text primary key,
  order_id        text not null unique references orders (order_id),
  custody_status  text not null check (custody_status in ('VERIFIED', 'THERMAL_BREACH', 'UNAUTHORIZED_ACCESS')),
  integrity_hash  text not null,
  report          jsonb not null,
  generated_at    timestamptz not null default now()
);

create or replace function orders_audit_reports_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Los reportes de auditoría consolidados son inmutables';
end;
$$;
drop trigger if exists orders_audit_reports_immutable on orders_audit_reports;
create trigger orders_audit_reports_immutable before update or delete on orders_audit_reports
  for each row execute function orders_audit_reports_immutable();

-- Solo el backend (rol postgres) accede; la API pública de Supabase queda bloqueada
alter table orders enable row level security;
alter table orders_evidence enable row level security;
alter table orders_audit_reports enable row level security;
