/**
 * Repositorio PostgreSQL de seguridad (tablas security_*).
 * Devuelve objetos con la misma forma que la API ya expone.
 */
const { pool, migrate, legacyState, tx } = require('./store');
const { newId, generateCode, maskCode, normId, evaluateOtp, classifyTamper } = require('./rules');

const iso = (v) => (v ? new Date(v).toISOString() : null);

const otpView = (r) => ({
  otpId: r.otp_id,
  code: r.code,
  orderId: r.order_id,
  smartBoxId: r.smart_box_id,
  used: r.used,
  revoked: r.revoked,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  ...(r.used_at ? { usedAt: iso(r.used_at) } : {})
});
const lockView = (r, smartBoxId) =>
  r ? { smartBoxId: r.smart_box_id, lockState: r.lock_state, orderId: r.order_id, updatedAt: iso(r.updated_at) } : { smartBoxId, lockState: 'LOCKED', orderId: null, updatedAt: null };
const attemptView = (r) => ({
  attemptId: r.attempt_id,
  smartBoxId: r.smart_box_id,
  orderId: r.order_id,
  codeMasked: r.code_masked,
  action: r.action,
  result: r.result,
  timestamp: iso(r.created_at)
});
const eventView = (r) => ({
  eventId: r.event_id,
  smartBoxId: r.smart_box_id,
  orderId: r.order_id,
  lidOpen: r.lid_open,
  packagePresent: r.package_present,
  forced: r.forced,
  authorized: r.authorized,
  timestamp: iso(r.created_at)
});
const alertView = (r) => ({
  alertId: r.alert_id,
  type: r.type,
  severity: r.severity,
  smartBoxId: r.smart_box_id,
  orderId: r.order_id,
  message: r.message,
  resolved: r.resolved,
  timestamp: iso(r.created_at),
  ...(r.resolved_at ? { resolvedAt: iso(r.resolved_at) } : {})
});

const insertAttempt = (c, a) =>
  c.query(
    'insert into security_access_attempts (attempt_id, smart_box_id, order_id, code_masked, action, result, created_at) values ($1,$2,$3,$4,$5,$6,coalesce($7, now())) returning *',
    [a.attemptId || newId('ATT'), a.smartBoxId, normId(a.orderId), a.codeMasked, a.action, a.result, a.timestamp || null]
  );
const insertEvent = (c, e) =>
  c.query(
    'insert into security_tamper_events (event_id, smart_box_id, order_id, lid_open, package_present, forced, authorized, created_at) values ($1,$2,$3,$4,$5,$6,$7,coalesce($8, now())) returning *',
    [e.eventId || newId('EVT'), e.smartBoxId, normId(e.orderId), e.lidOpen, e.packagePresent ?? null, !!e.forced, e.authorized ?? null, e.timestamp || null]
  );
const insertAlert = (c, a) =>
  c.query(
    'insert into security_alerts (alert_id, type, severity, smart_box_id, order_id, message, resolved, created_at, resolved_at) values ($1,$2,$3,$4,$5,$6,$7,coalesce($8, now()),$9) returning *',
    [a.alertId || newId('ALT-SEC'), a.type, a.severity, a.smartBoxId, normId(a.orderId), a.message, !!a.resolved, a.timestamp || null, a.resolvedAt || null]
  );

module.exports = {
  /** Crea las tablas y, si están vacías, importa el documento previo de service_state. */
  async init() {
    await migrate();
    const { rows } = await pool.query(
      'select (select count(*) from security_otps) + (select count(*) from security_locks) + (select count(*) from security_access_attempts) + (select count(*) from security_tamper_events) + (select count(*) from security_alerts) as n'
    );
    if (Number(rows[0].n) > 0) return 'tablas listas';
    const legacy = await legacyState('security');
    if (!legacy) return 'tablas creadas';
    await tx(async (c) => {
      for (const o of legacy.otps || []) {
        await c.query(
          'insert into security_otps (otp_id, order_id, smart_box_id, code, used, revoked, created_at, expires_at, used_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [o.otpId, normId(o.orderId), o.smartBoxId, o.code, !!o.used, !!o.revoked, o.createdAt, o.expiresAt, o.usedAt || null]
        );
      }
      for (const l of Object.values(legacy.locks || {})) {
        await c.query('insert into security_locks (smart_box_id, lock_state, order_id, updated_at) values ($1,$2,$3,$4)', [l.smartBoxId, l.lockState, normId(l.orderId), l.updatedAt]);
      }
      for (const a of legacy.accessAttempts || []) await insertAttempt(c, a);
      for (const e of legacy.tamperEvents || []) await insertEvent(c, e);
      for (const a of legacy.alerts || []) await insertAlert(c, a);
    });
    return 'importado desde service_state';
  },

  /** Emite un OTP nuevo y revoca los no usados del mismo envío. */
  async issueOtp({ orderId, smartBoxId, ttlMinutes }) {
    return tx(async (c) => {
      await c.query('update security_otps set revoked = true where order_id = $1 and not used and not revoked', [normId(orderId)]);
      const { rows } = await c.query(
        "insert into security_otps (otp_id, order_id, smart_box_id, code, expires_at) values ($1,$2,$3,$4, now() + make_interval(mins => $5)) returning *",
        [newId('OTP'), normId(orderId), smartBoxId, generateCode(), ttlMinutes]
      );
      return otpView(rows[0]);
    });
  },

  async latestOtp(orderId) {
    const { rows } = await pool.query('select * from security_otps where order_id = $1 order by created_at desc limit 1', [normId(orderId)]);
    return rows[0] ? otpView(rows[0]) : null;
  },

  /**
   * Evalúa un código, registra el intento y, si consume=true y es válido, lo marca usado y desbloquea.
   * Devuelve { result, otp, lock }.
   */
  async checkOtp({ orderId, smartBoxId, code, action, consume }) {
    return tx(async (c) => {
      const { rows } = await c.query(
        'select * from security_otps where smart_box_id = $1 and ($2::text is null or order_id = $2) and code = $3 order by created_at desc limit 1 for update',
        [smartBoxId, normId(orderId), String(code)]
      );
      const otp = rows[0] ? otpView(rows[0]) : null;
      const result = evaluateOtp(otp);
      await insertAttempt(c, { smartBoxId, orderId: orderId || otp?.orderId, codeMasked: maskCode(code), action, result });

      let lock;
      if (consume && result === 'AUTHORIZED') {
        await c.query('update security_otps set used = true, used_at = now() where otp_id = $1', [otp.otpId]);
        const l = await c.query(
          `insert into security_locks (smart_box_id, lock_state, order_id, updated_at) values ($1, 'UNLOCKED', $2, now())
           on conflict (smart_box_id) do update set lock_state = 'UNLOCKED', order_id = excluded.order_id, updated_at = now() returning *`,
          [smartBoxId, otp.orderId]
        );
        lock = lockView(l.rows[0]);
      } else {
        const l = await c.query('select * from security_locks where smart_box_id = $1', [smartBoxId]);
        lock = lockView(l.rows[0], smartBoxId);
      }
      return { result, otp, lock };
    });
  },

  async lock(smartBoxId) {
    const { rows } = await pool.query('select * from security_locks where smart_box_id = $1', [smartBoxId]);
    return lockView(rows[0], smartBoxId);
  },

  /** Registra un evento de tapa aplicando la lógica de 2 niveles. */
  async recordTamper({ smartBoxId, orderId, lidOpen, packagePresent, forced }) {
    return tx(async (c) => {
      const l = await c.query('select * from security_locks where smart_box_id = $1 for update', [smartBoxId]);
      const lock = lockView(l.rows[0], smartBoxId);
      const decision = classifyTamper({ lock, lidOpen, packagePresent, forced });
      const ref = normId(orderId) || lock.orderId || null;

      const ev = await insertEvent(c, { smartBoxId, orderId: ref, lidOpen, packagePresent, forced, authorized: decision.authorized });
      let alert = null;
      if (decision.alert) {
        const a = await insertAlert(c, { ...decision.alert, smartBoxId, orderId: ref });
        alert = alertView(a.rows[0]);
      }
      let lockState = lock.lockState;
      if (decision.relock) {
        await c.query(
          `insert into security_locks (smart_box_id, lock_state, order_id, updated_at) values ($1, 'LOCKED', $2, now())
           on conflict (smart_box_id) do update set lock_state = 'LOCKED', updated_at = now()`,
          [smartBoxId, ref]
        );
        lockState = 'LOCKED';
      }
      return { event: eventView(ev.rows[0]), alert, lockState };
    });
  },

  async events({ orderId, smartBoxId }) {
    const { rows } = await pool.query(
      'select * from security_tamper_events where ($1::text is null or order_id = $1) and ($2::text is null or smart_box_id = $2) order by created_at, event_id',
      [normId(orderId), smartBoxId || null]
    );
    return rows.map(eventView);
  },

  async attempts({ orderId, smartBoxId }) {
    const { rows } = await pool.query(
      'select * from security_access_attempts where ($1::text is null or order_id = $1) and ($2::text is null or smart_box_id = $2) order by created_at, attempt_id',
      [normId(orderId), smartBoxId || null]
    );
    return rows.map(attemptView);
  },

  /** Ordenadas por severidad y luego de la más reciente a la más antigua. */
  async alerts({ resolved, type, orderId }) {
    const { rows } = await pool.query(
      `select * from security_alerts
        where ($1::boolean is null or resolved = $1) and ($2::text is null or type = $2) and ($3::text is null or order_id = $3)
        order by case severity when 'CRITICAL' then 0 when 'WARNING' then 1 else 2 end, created_at desc`,
      [resolved === undefined ? null : resolved === 'true', type || null, normId(orderId)]
    );
    return rows.map(alertView);
  },

  async resolveAlert(alertId) {
    const { rows } = await pool.query('update security_alerts set resolved = true, resolved_at = coalesce(resolved_at, now()) where alert_id = $1 returning *', [alertId]);
    return rows[0] ? alertView(rows[0]) : null;
  }
};
