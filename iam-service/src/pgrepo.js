/**
 * Repositorio PostgreSQL de IAM (tablas iam_*).
 * Devuelve objetos con la misma forma que la API ya expone.
 */
const crypto = require('crypto');
const { pool, migrate, legacyState, tx } = require('./store');

const num = (v) => (v === null || v === undefined ? v : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const restaurant = (r) => ({
  restaurantId: r.restaurant_id,
  name: r.name,
  ruc: r.ruc,
  phone: r.phone,
  address: r.address,
  settings: {
    defaultThresholds: {
      COLD: { minTemperature: num(r.cold_min_temperature), maxTemperature: num(r.cold_max_temperature) },
      HOT: { minTemperature: num(r.hot_min_temperature), maxTemperature: num(r.hot_max_temperature) }
    },
    notifications: { email: r.notify_email, push: r.notify_push, criticalOnly: r.notify_critical_only }
  },
  subscription: {
    plan: r.plan,
    status: r.sub_status,
    paymentMethod: r.payment_last4 ? { brand: r.payment_brand, last4: r.payment_last4 } : null,
    startedAt: iso(r.started_at),
    renewsAt: iso(r.renews_at)
  },
  createdAt: iso(r.created_at)
});
const user = (r) => ({
  userId: r.user_id,
  email: r.email,
  passwordHash: r.password_hash,
  name: r.name,
  role: r.role,
  restaurantId: r.restaurant_id,
  createdAt: iso(r.created_at)
});
const operator = (r) => ({
  operatorId: r.operator_id,
  restaurantId: r.restaurant_id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  status: r.status,
  completedDeliveries: r.completed_deliveries,
  custodyRating: num(r.custody_rating),
  invitedAt: iso(r.invited_at),
  ...(r.updated_at ? { updatedAt: iso(r.updated_at) } : {})
});

const RESTAURANT_SELECT = `select r.*, s.plan, s.status as sub_status, s.payment_brand, s.payment_last4, s.started_at, s.renews_at
  from iam_restaurants r join iam_subscriptions s on s.restaurant_id = r.restaurant_id`;

const restaurantParams = (r) => {
  const t = r.settings.defaultThresholds;
  const n = r.settings.notifications;
  return [r.restaurantId, r.name, r.ruc || null, r.phone || null, r.address || null,
    t.COLD.minTemperature, t.COLD.maxTemperature, t.HOT.minTemperature, t.HOT.maxTemperature, !!n.email, !!n.push, !!n.criticalOnly];
};
const subscriptionParams = (r) => {
  const s = r.subscription;
  return [r.restaurantId, s.plan, s.status, s.paymentMethod?.brand || null, s.paymentMethod?.last4 || null, s.startedAt, s.renewsAt || null];
};

const insertRestaurant = async (c, r) => {
  await c.query(
    `insert into iam_restaurants (restaurant_id, name, ruc, phone, address, cold_min_temperature, cold_max_temperature,
       hot_min_temperature, hot_max_temperature, notify_email, notify_push, notify_critical_only, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13, now()))`,
    [...restaurantParams(r), r.createdAt || null]
  );
  await c.query(
    'insert into iam_subscriptions (restaurant_id, plan, status, payment_brand, payment_last4, started_at, renews_at) values ($1,$2,$3,$4,$5,$6,$7)',
    subscriptionParams(r)
  );
};
const insertUser = (c, u) =>
  c.query(
    'insert into iam_users (user_id, restaurant_id, email, password_hash, name, role, created_at) values ($1,$2,$3,$4,$5,$6,coalesce($7, now()))',
    [u.userId, u.restaurantId, u.email, u.passwordHash, u.name, u.role, u.createdAt || null]
  );
const insertOperator = (c, o) =>
  c.query(
    `insert into iam_operators (operator_id, restaurant_id, name, email, phone, status, completed_deliveries, custody_rating, invited_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9, now())) returning *`,
    [o.operatorId, o.restaurantId, o.name, o.email, o.phone || null, o.status, o.completedDeliveries || 0, o.custodyRating ?? null, o.invitedAt || null]
  );

const emailConflict = (e) => (e.code === '23505' && /email/.test(e.constraint || '') ? Object.assign(new Error('EMAIL_TAKEN'), { code: 'EMAIL_TAKEN' }) : e);

module.exports = {
  /** Crea las tablas y, si están vacías, importa el documento previo (service_state) o el seed. */
  async init(seed) {
    await migrate();
    const { rows } = await pool.query('select count(*)::int as n from iam_restaurants');
    if (rows[0].n > 0) return 'tablas listas';
    const legacy = await legacyState('iam');
    const data = legacy && Array.isArray(legacy.restaurants) ? legacy : seed;
    await tx(async (c) => {
      for (const r of data.restaurants) await insertRestaurant(c, r);
      for (const u of data.users) await insertUser(c, u);
      for (const o of data.operators) await insertOperator(c, o);
      for (const t of data.resetTokens || []) {
        await c.query('insert into iam_password_resets (token_hash, user_id, expires_at) values ($1,$2,$3) on conflict do nothing', [sha256(t.token), t.userId, t.expiresAt]);
      }
    });
    return legacy ? `importado desde service_state (${data.users.length} usuarios, ${data.operators.length} operadores)` : 'datos iniciales cargados';
  },

  async restaurant(restaurantId) {
    const { rows } = await pool.query(`${RESTAURANT_SELECT} where r.restaurant_id = $1`, [restaurantId]);
    return rows[0] ? restaurant(rows[0]) : null;
  },

  async userById(userId) {
    const { rows } = await pool.query('select * from iam_users where user_id = $1', [userId]);
    return rows[0] ? user(rows[0]) : null;
  },

  async userByEmail(email) {
    const { rows } = await pool.query('select * from iam_users where email = $1', [email]);
    return rows[0] ? user(rows[0]) : null;
  },

  /** El email no puede repetirse entre administradores ni operadores. */
  async emailTaken(email) {
    const { rows } = await pool.query('select 1 from iam_users where email = $1 union all select 1 from iam_operators where email = $1 limit 1', [email]);
    return rows.length > 0;
  },

  async register(rest, admin) {
    try {
      await tx(async (c) => {
        await insertRestaurant(c, rest);
        await insertUser(c, admin);
      });
    } catch (e) {
      throw emailConflict(e);
    }
  },

  async saveUser(u) {
    await pool.query('update iam_users set name = $2, password_hash = $3, updated_at = now() where user_id = $1', [u.userId, u.name, u.passwordHash]);
  },

  /** Guarda datos, ajustes y suscripción del restaurante. */
  async saveRestaurant(r) {
    await tx(async (c) => {
      await c.query(
        `update iam_restaurants set name = $2, ruc = $3, phone = $4, address = $5, cold_min_temperature = $6, cold_max_temperature = $7,
           hot_min_temperature = $8, hot_max_temperature = $9, notify_email = $10, notify_push = $11, notify_critical_only = $12
         where restaurant_id = $1`,
        restaurantParams(r)
      );
      await c.query(
        'update iam_subscriptions set plan = $2, status = $3, payment_brand = $4, payment_last4 = $5, started_at = $6, renews_at = $7 where restaurant_id = $1',
        subscriptionParams(r)
      );
    });
  },

  async setResetToken(userId, token, expiresAt) {
    await tx(async (c) => {
      await c.query('delete from iam_password_resets where user_id = $1 or expires_at < now()', [userId]);
      await c.query('insert into iam_password_resets (token_hash, user_id, expires_at) values ($1,$2,$3)', [sha256(token), userId, expiresAt]);
    });
  },

  /** Cambia la contraseña si el token es válido y lo consume. Devuelve false si es inválido o expiró. */
  async resetPassword(token, passwordHash) {
    return tx(async (c) => {
      const { rows } = await c.query('delete from iam_password_resets where token_hash = $1 returning user_id, expires_at', [sha256(token)]);
      if (!rows[0] || new Date(rows[0].expires_at) < new Date()) return false;
      await c.query('update iam_users set password_hash = $2, updated_at = now() where user_id = $1', [rows[0].user_id, passwordHash]);
      return true;
    });
  },

  async operators(restaurantId, status) {
    const { rows } = await pool.query(
      'select * from iam_operators where restaurant_id = $1 and ($2::text is null or status = $2) order by invited_at, operator_id',
      [restaurantId, status || null]
    );
    return rows.map(operator);
  },

  async countOperators(restaurantId) {
    const { rows } = await pool.query("select count(*)::int as n from iam_operators where restaurant_id = $1 and status <> 'INACTIVE'", [restaurantId]);
    return rows[0].n;
  },

  async operator(restaurantId, operatorId) {
    const { rows } = await pool.query('select * from iam_operators where restaurant_id = $1 and operator_id = $2', [restaurantId, operatorId]);
    return rows[0] ? operator(rows[0]) : null;
  },

  async createOperator(o) {
    try {
      const { rows } = await insertOperator(pool, o);
      return operator(rows[0]);
    } catch (e) {
      throw emailConflict(e);
    }
  },

  async setOperatorStatus(restaurantId, operatorId, status) {
    const { rows } = await pool.query(
      'update iam_operators set status = $3, updated_at = now() where restaurant_id = $1 and operator_id = $2 returning *',
      [restaurantId, operatorId, status]
    );
    return rows[0] ? operator(rows[0]) : null;
  }
};
