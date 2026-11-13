/**
 * Repositorio PostgreSQL de SmartBox (tablas container_smartboxes, container_alerts).
 * Devuelve objetos con la misma forma que la API ya expone.
 */
const { pool, migrate, legacyState, tx } = require('./store');

const num = (v) => (v === null || v === undefined ? v : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);

const box = (r) => ({
  boxId: r.box_id,
  serialNumber: r.serial_number,
  macAddress: r.mac_address,
  maxWeightKg: num(r.max_weight_kg),
  status: r.status,
  deviceId: r.device_id,
  batteryLevel: num(r.battery_level),
  isOnline: r.is_online,
  lastHeartbeat: iso(r.last_heartbeat)
});
const alert = (r) => ({
  alertId: r.alert_id,
  type: r.type,
  severity: r.severity,
  boxId: r.box_id,
  batteryLevel: num(r.battery_level),
  resolved: r.resolved,
  timestamp: iso(r.last_seen_at),
  ...(r.resolved_at ? { resolvedAt: iso(r.resolved_at) } : {})
});

const conflict = (e) => {
  if (e.code !== '23505') return e;
  const code = { container_smartboxes_serial_number_key: 'SERIAL_TAKEN', container_smartboxes_mac_address_key: 'MAC_TAKEN', container_smartboxes_device_id_key: 'DEVICE_TAKEN' }[e.constraint];
  return code ? Object.assign(new Error(code), { code }) : e;
};

const insertBox = (c, b) =>
  c.query(
    `insert into container_smartboxes (box_id, serial_number, mac_address, max_weight_kg, status, device_id, battery_level, is_online, last_heartbeat)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [b.boxId, b.serialNumber, b.macAddress.toUpperCase(), b.maxWeightKg, b.status, b.deviceId || null, b.batteryLevel, !!b.isOnline, b.lastHeartbeat || null]
  );

module.exports = {
  /** Crea las tablas y, si están vacías, importa el documento previo (service_state) o el seed. */
  async init(seed) {
    await migrate();
    const { rows } = await pool.query('select count(*)::int as n from container_smartboxes');
    if (rows[0].n > 0) return 'tablas listas';
    const legacy = await legacyState('container');
    const data = legacy && Array.isArray(legacy.smartboxes) ? legacy : seed;
    await tx(async (c) => {
      for (const b of data.smartboxes) await insertBox(c, b);
      for (const a of data.alerts || []) {
        await c.query(
          'insert into container_alerts (alert_id, type, severity, box_id, battery_level, resolved, created_at, last_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$7)',
          [a.alertId, a.type, a.severity, a.boxId, a.batteryLevel, !!a.resolved, a.timestamp]
        );
      }
    });
    return legacy ? `importado desde service_state (${data.smartboxes.length} cajas)` : 'datos iniciales cargados';
  },

  async list() {
    const { rows } = await pool.query('select * from container_smartboxes order by box_id');
    return rows.map(box);
  },

  async available(minBattery) {
    const { rows } = await pool.query("select * from container_smartboxes where status = 'AVAILABLE' and battery_level >= $1 order by box_id", [minBattery]);
    return rows.map(box);
  },

  async find(boxId) {
    const { rows } = await pool.query('select * from container_smartboxes where box_id = $1', [boxId]);
    return rows[0] ? box(rows[0]) : null;
  },

  /** Alta con el siguiente correlativo SB-NNN. Lanza SERIAL_TAKEN / MAC_TAKEN. */
  async create({ serialNumber, macAddress, maxWeightKg }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { rows } = await pool.query(
          `insert into container_smartboxes (box_id, serial_number, mac_address, max_weight_kg)
           select 'SB-' || lpad((coalesce(max(substring(box_id from '^SB-(\\d+)$')::int), 0) + 1)::text, 3, '0'), $1, $2, $3
             from container_smartboxes
           returning *`,
          [serialNumber, macAddress, maxWeightKg]
        );
        return box(rows[0]);
      } catch (e) {
        if (e.code === '23505' && e.constraint === 'container_smartboxes_pkey') continue;
        throw conflict(e);
      }
    }
    throw new Error('No se pudo asignar un ID de SmartBox');
  },

  /** Lanza DEVICE_TAKEN (con .other) si el dispositivo ya está en otra caja. */
  async pairDevice(boxId, deviceId) {
    const { rows } = await pool.query('select box_id from container_smartboxes where device_id = $1 and box_id <> $2', [deviceId, boxId]);
    if (rows[0]) throw Object.assign(new Error('DEVICE_TAKEN'), { code: 'DEVICE_TAKEN', other: rows[0].box_id });
    try {
      const upd = await pool.query('update container_smartboxes set device_id = $2 where box_id = $1 returning *', [boxId, deviceId]);
      return upd.rows[0] ? box(upd.rows[0]) : null;
    } catch (e) {
      throw conflict(e);
    }
  },

  async setStatus(boxId, status) {
    const { rows } = await pool.query('update container_smartboxes set status = $2 where box_id = $1 returning *', [boxId, status]);
    return rows[0] ? box(rows[0]) : null;
  },

  /** Actualiza batería/conexión y abre, actualiza o cierra la alerta LOW_BATTERY. */
  async heartbeat({ boxId, deviceId, batteryLevel, threshold }) {
    return tx(async (c) => {
      const upd = await c.query(
        `update container_smartboxes set battery_level = $3, is_online = true, last_heartbeat = now()
          where box_id = coalesce($1, (select box_id from container_smartboxes where device_id = $2)) returning *`,
        [boxId || null, deviceId || null, batteryLevel]
      );
      if (!upd.rows[0]) return null;
      const b = box(upd.rows[0]);

      let a = null;
      if (batteryLevel < threshold) {
        const r = await c.query(
          `insert into container_alerts (alert_id, box_id, battery_level) values ($1, $2, $3)
           on conflict (box_id, type) where not resolved do update set battery_level = excluded.battery_level, last_seen_at = now()
           returning *`,
          ['ALT-BAT-' + Date.now() + '-' + Math.floor(Math.random() * 1000), b.boxId, batteryLevel]
        );
        a = alert(r.rows[0]);
      } else {
        // Batería recuperada: cerrar alertas abiertas
        await c.query("update container_alerts set resolved = true, resolved_at = now() where box_id = $1 and type = 'LOW_BATTERY' and not resolved", [b.boxId]);
      }
      return { smartBox: b, alert: a };
    });
  },

  async alerts() {
    const { rows } = await pool.query('select * from container_alerts order by created_at');
    return rows.map(alert);
  },

  async resolveAlert(alertId) {
    const { rows } = await pool.query('update container_alerts set resolved = true, resolved_at = coalesce(resolved_at, now()) where alert_id = $1 returning *', [alertId]);
    return rows[0] ? alert(rows[0]) : null;
  }
};
