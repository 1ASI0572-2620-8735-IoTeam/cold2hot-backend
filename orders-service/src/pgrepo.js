/**
 * Repositorio PostgreSQL de envíos (tablas orders, orders_evidence, orders_audit_reports).
 * Devuelve objetos con la misma forma que la API ya expone.
 */
const { pool, migrate, legacyState, tx } = require('./store');

const num = (v) => (v === null || v === undefined ? v : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const ACTIVE = ['CREATED', 'IN_TRANSIT'];

const SELECT = (withPhoto) =>
  `select o.*, e.photo_url, e.uploaded_at as evidence_uploaded_at${withPhoto ? ', e.photo_base64' : ''}
     from orders o left join orders_evidence e on e.order_id = o.order_id`;

const order = (r) => ({
  orderId: r.order_id,
  customerName: r.customer_name,
  deliveryAddress: r.delivery_address,
  smartBoxId: r.smart_box_id,
  operatorId: r.operator_id,
  operatorName: r.operator_name,
  thermalProfile: { type: r.thermal_type, minTemperature: num(r.min_temperature), maxTemperature: num(r.max_temperature) },
  status: r.status,
  incidents: r.incidents || [],
  evidence: r.evidence_uploaded_at
    ? { photoUrl: r.photo_url, ...(r.photo_base64 ? { photoBase64: r.photo_base64 } : {}), uploadedAt: iso(r.evidence_uploaded_at) }
    : null,
  createdAt: iso(r.created_at),
  deliveredAt: iso(r.delivered_at)
});

const insertOrder = (c, o) =>
  c.query(
    `insert into orders (order_id, customer_name, delivery_address, smart_box_id, operator_id, operator_name, thermal_type,
                         min_temperature, max_temperature, status, incidents, created_at, delivered_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [o.orderId, o.customerName, o.deliveryAddress, o.smartBoxId, o.operatorId, o.operatorName, o.thermalProfile.type,
      o.thermalProfile.minTemperature, o.thermalProfile.maxTemperature, o.status, o.incidents || [], o.createdAt, o.deliveredAt]
  );

const insertEvidence = (c, orderId, e) =>
  c.query(
    `insert into orders_evidence (order_id, photo_url, storage_path, photo_base64, content_type, size_bytes, uploaded_at)
     values ($1,$2,$3,$4,$5,$6,coalesce($7, now()))
     on conflict (order_id) do update set photo_url = excluded.photo_url, storage_path = excluded.storage_path,
       photo_base64 = excluded.photo_base64, content_type = excluded.content_type, size_bytes = excluded.size_bytes,
       uploaded_at = excluded.uploaded_at`,
    [orderId, e.photoUrl || null, e.storagePath || null, e.photoBase64 || null, e.contentType || null, e.sizeBytes || null, e.uploadedAt || null]
  );

const insertAudit = (c, r) =>
  c.query(
    `insert into orders_audit_reports (report_id, order_id, custody_status, integrity_hash, report, generated_at)
     values ($1,$2,$3,$4,$5,$6) on conflict (order_id) do nothing returning report`,
    [r.reportId, r.orderId, r.custodyStatus, r.integrityHash, JSON.stringify(r), r.generatedAt]
  );

module.exports = {
  /** Crea las tablas y, si están vacías, importa el documento previo (service_state) o el seed. */
  async init(seed) {
    await migrate();
    const { rows } = await pool.query('select count(*)::int as n from orders');
    if (rows[0].n > 0) return 'tablas listas';
    const legacy = await legacyState('orders');
    const data = legacy && Array.isArray(legacy.orders) ? legacy : seed;
    await tx(async (c) => {
      for (const o of data.orders) {
        await insertOrder(c, o);
        if (o.evidence && (o.evidence.photoUrl || o.evidence.photoBase64)) await insertEvidence(c, o.orderId, o.evidence);
      }
      for (const r of Object.values(data.audits || {})) await insertAudit(c, r);
    });
    return legacy ? `importado desde service_state (${data.orders.length} envíos)` : 'datos iniciales cargados';
  },

  async list({ q, status, operator, smartBoxId, profile, from, to }) {
    const like = q ? '%' + q.replace(/^#/, '').replace(/[\\%_]/g, '\\$&') + '%' : null;
    const { rows } = await pool.query(
      `${SELECT(false)}
       where ($1::text is null or (o.order_id || ' ' || o.customer_name || ' ' || o.delivery_address) ilike $1)
         and ($2::text is null or o.status = $2)
         and ($3::text is null or o.operator_id = $3 or lower(o.operator_name) = lower($3))
         and ($4::text is null or o.smart_box_id = $4)
         and ($5::text is null or o.thermal_type = $5)
         and ($6::date is null or o.created_at >= $6::date)
         and ($7::date is null or (o.created_at at time zone 'UTC')::date <= $7::date)
       order by o.created_at desc`,
      [like, status || null, operator || null, smartBoxId || null, profile || null, from || null, to || null]
    );
    return rows.map(order);
  },

  async active() {
    const { rows } = await pool.query(`${SELECT(false)} where o.status = any($1) order by o.created_at desc`, [ACTIVE]);
    return rows.map(order);
  },

  async find(orderId, { withPhoto = false } = {}) {
    const { rows } = await pool.query(`${SELECT(withPhoto)} where o.order_id = $1`, [orderId]);
    return rows[0] ? order(rows[0]) : null;
  },

  async boxBusy(smartBoxId) {
    const { rows } = await pool.query('select 1 from orders where smart_box_id = $1 and status = any($2) limit 1', [smartBoxId, ACTIVE]);
    return rows.length > 0;
  },

  /** Inserta con el siguiente correlativo C2H-NNNNN. Lanza { code: 'BOX_BUSY' } si la caja ya tiene envío en curso. */
  async create(o) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { rows } = await pool.query(
          `insert into orders (order_id, customer_name, delivery_address, smart_box_id, operator_id, operator_name,
                               thermal_type, min_temperature, max_temperature, status)
           select 'C2H-' || (coalesce(max(substring(order_id from '^C2H-(\\d+)$')::int), 10000) + 1), $1,$2,$3,$4,$5,$6,$7,$8,$9
             from orders
           returning *`,
          [o.customerName, o.deliveryAddress, o.smartBoxId, o.operatorId, o.operatorName, o.thermalProfile.type,
            o.thermalProfile.minTemperature, o.thermalProfile.maxTemperature, o.status]
        );
        return order(rows[0]);
      } catch (e) {
        if (e.code === '23505' && e.constraint === 'orders_one_active_per_box') throw Object.assign(new Error('BOX_BUSY'), { code: 'BOX_BUSY' });
        if (e.code === '23505' && e.constraint === 'orders_pkey') continue; // dos altas simultáneas: reintentar
        throw e;
      }
    }
    throw new Error('No se pudo asignar un ID de envío');
  },

  async deliveredInMonth(month) {
    const { rows } = await pool.query(
      `${SELECT(false)} where o.status = 'DELIVERED' and to_char(coalesce(o.delivered_at, o.created_at) at time zone 'UTC', 'YYYY-MM') = $1`,
      [month]
    );
    return rows.map(order);
  },

  /** Marca DELIVERED y guarda la evidencia. Devuelve null si el envío ya no estaba en curso. */
  async deliver(orderId, evidence) {
    const done = await tx(async (c) => {
      const upd = await c.query(
        "update orders set status = 'DELIVERED', delivered_at = now() where order_id = $1 and status = any($2) returning order_id",
        [orderId, ACTIVE]
      );
      if (!upd.rows.length) return false;
      await insertEvidence(c, orderId, evidence);
      return true;
    });
    return done ? this.find(orderId, { withPhoto: true }) : null;
  },

  async audit(orderId) {
    const { rows } = await pool.query('select report from orders_audit_reports where order_id = $1', [orderId]);
    return rows[0] ? rows[0].report : null;
  },

  /** Guarda el reporte consolidado. Devuelve null si ya existía uno. */
  async saveAudit(report) {
    const { rows } = await insertAudit(pool, report);
    return rows[0] ? rows[0].report : null;
  },

  /** Evidencias guardadas en Base64 (Storage no configurado en su momento) pendientes de subir. */
  async pendingPhotos() {
    const { rows } = await pool.query('select order_id, photo_base64 from orders_evidence where photo_base64 is not null and storage_path is null');
    return rows.map((r) => ({ orderId: r.order_id, photoBase64: r.photo_base64 }));
  },

  async movePhotoToStorage(orderId, stored) {
    await pool.query(
      'update orders_evidence set photo_url = $2, storage_path = $3, content_type = $4, size_bytes = $5, photo_base64 = null where order_id = $1',
      [orderId, stored.photoUrl, stored.storagePath, stored.contentType, stored.sizeBytes]
    );
  }
};
