/**
 * Repositorio PostgreSQL de telemetría (tablas telemetry_profiles, telemetry_readings, telemetry_alerts).
 * Devuelve objetos con la misma forma que la API ya expone.
 */
const num = (v) => (v === null || v === undefined ? v : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : v);

const profile = (r) => ({
  profileId: r.profile_id,
  orderId: r.order_id,
  smartBoxId: r.smart_box_id,
  type: r.type,
  minTemperature: num(r.min_temperature),
  maxTemperature: num(r.max_temperature),
  active: r.active,
  createdAt: iso(r.created_at)
});
const log = (r) => ({
  id: 'TLOG-' + r.id,
  smartBoxId: r.smart_box_id,
  shipmentId: r.order_id,
  temperature: num(r.temperature),
  lidOpen: r.lid_open,
  inRange: r.in_range,
  timestamp: iso(r.recorded_at)
});
const alert = (r) => ({
  alertId: r.alert_id,
  type: r.type,
  severity: r.severity,
  orderId: r.order_id,
  smartBoxId: r.smart_box_id,
  temperature: num(r.temperature),
  minTemperature: num(r.min_temperature),
  maxTemperature: num(r.max_temperature),
  message: r.message,
  readingsOutOfRange: r.readings_out_of_range,
  resolved: r.resolved,
  timestamp: iso(r.created_at),
  ...(r.last_seen_at ? { lastSeenAt: iso(r.last_seen_at) } : {}),
  ...(r.resolved_at ? { resolvedAt: iso(r.resolved_at) } : {})
});

module.exports = (pool) => ({
  async seedIfEmpty(seed) {
    const { rows } = await pool.query('select (select count(*) from telemetry_profiles) + (select count(*) from telemetry_readings) + (select count(*) from telemetry_alerts) as n');
    if (Number(rows[0].n) > 0) return false;
    for (const p of seed.profiles) {
      await pool.query(
        'insert into telemetry_profiles (profile_id, order_id, smart_box_id, type, min_temperature, max_temperature, active, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [p.profileId, p.orderId, p.smartBoxId, p.type, p.minTemperature, p.maxTemperature, p.active, p.createdAt]
      );
    }
    for (const l of [...seed.logs].reverse()) {
      await pool.query('insert into telemetry_readings (smart_box_id, order_id, temperature, lid_open, in_range, recorded_at) values ($1,$2,$3,$4,$5,$6)', [l.smartBoxId, l.shipmentId, l.temperature, l.lidOpen, l.inRange, l.timestamp]);
    }
    for (const a of seed.alerts) {
      await pool.query(
        'insert into telemetry_alerts (alert_id, type, severity, order_id, smart_box_id, temperature, min_temperature, max_temperature, message, resolved, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [a.alertId, a.type, a.severity, a.orderId, a.smartBoxId, a.temperature, a.minTemperature, a.maxTemperature, a.message, a.resolved, a.timestamp]
      );
    }
    return true;
  },

  async activeProfile({ orderId, smartBoxId }) {
    const { rows } = orderId
      ? await pool.query('select * from telemetry_profiles where active and order_id = $1 limit 1', [orderId])
      : await pool.query('select * from telemetry_profiles where active and smart_box_id = $1 order by created_at desc limit 1', [smartBoxId]);
    return rows[0] ? profile(rows[0]) : null;
  },

  async createProfile(p) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('update telemetry_profiles set active = false where active and (smart_box_id = $1 or order_id = $2)', [p.smartBoxId, p.orderId]);
      await client.query('delete from telemetry_profiles where profile_id = $1', [p.profileId]);
      const { rows } = await client.query(
        'insert into telemetry_profiles (profile_id, order_id, smart_box_id, type, min_temperature, max_temperature, active) values ($1,$2,$3,$4,$5,$6,true) returning *',
        [p.profileId, p.orderId, p.smartBoxId, p.type, p.minTemperature, p.maxTemperature]
      );
      await client.query('commit');
      return profile(rows[0]);
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  },

  async listProfiles(active) {
    const { rows } = active === undefined
      ? await pool.query('select * from telemetry_profiles order by created_at')
      : await pool.query('select * from telemetry_profiles where active = $1 order by created_at', [active === 'true']);
    return rows.map(profile);
  },

  async profileByOrder(orderId) {
    const { rows } = await pool.query('select * from telemetry_profiles where order_id = $1 order by created_at desc limit 1', [orderId]);
    return rows[0] ? profile(rows[0]) : null;
  },

  async insertReading(l) {
    const { rows } = await pool.query(
      'insert into telemetry_readings (smart_box_id, order_id, temperature, lid_open, in_range) values ($1,$2,$3,$4,$5) returning *',
      [l.smartBoxId, l.shipmentId, l.temperature, l.lidOpen, l.inRange]
    );
    return log(rows[0]);
  },

  /** Lecturas más recientes primero. */
  async logs({ orderId, smartBoxId, limit }) {
    const { rows } = await pool.query(
      'select * from telemetry_readings where ($1::text is null or order_id = $1) and ($2::text is null or smart_box_id = $2) order by recorded_at desc, id desc limit $3',
      [orderId || null, smartBoxId || null, limit]
    );
    return rows.map(log);
  },

  /** Registra o actualiza la única alerta térmica abierta del envío. */
  async upsertBreach({ orderId, smartBoxId, temperature, min, max, message }) {
    const upd = await pool.query(
      'update telemetry_alerts set temperature = $2, message = $3, last_seen_at = now(), readings_out_of_range = readings_out_of_range + 1 where order_id = $1 and type = \'THERMAL_BREACH\' and not resolved returning *',
      [orderId, temperature, message]
    );
    if (upd.rows[0]) return alert(upd.rows[0]);
    const { rows } = await pool.query(
      'insert into telemetry_alerts (alert_id, severity, order_id, smart_box_id, temperature, min_temperature, max_temperature, message) values ($1,\'CRITICAL\',$2,$3,$4,$5,$6,$7) returning *',
      ['ALT-TMP-' + Date.now() + '-' + Math.floor(Math.random() * 1000), orderId, smartBoxId, temperature, min, max, message]
    );
    return alert(rows[0]);
  },

  async alerts({ resolved, orderId, limit }) {
    const { rows } = await pool.query(
      'select * from telemetry_alerts where ($1::boolean is null or resolved = $1) and ($2::text is null or order_id = $2) order by created_at desc limit $3',
      [resolved === undefined ? null : resolved === 'true', orderId || null, limit]
    );
    return rows.map(alert);
  },

  async resolveAlert(alertId) {
    const { rows } = await pool.query('update telemetry_alerts set resolved = true, resolved_at = now() where alert_id = $1 returning *', [alertId]);
    return rows[0] ? alert(rows[0]) : null;
  }
});
