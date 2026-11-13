/**
 * Repositorio en memoria + archivo JSON (solo desarrollo, cuando no hay DATABASE_URL).
 * Misma interfaz que pgrepo.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.IAM_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => new Date().toISOString();
let db = { restaurants: [], users: [], operators: [], resetTokens: [] };

const save = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[IAM-SERVICE] No se pudo persistir en disco:', e.message);
  }
};
const replace = (list, key, item) => {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i >= 0) list[i] = clone(item);
};

module.exports = {
  async init(seed) {
    try {
      db = { resetTokens: [], ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
      return 'archivo local cargado';
    } catch {
      db = seed;
      return 'datos iniciales en memoria';
    }
  },

  async restaurant(id) {
    return clone(db.restaurants.find((r) => r.restaurantId === id)) || null;
  },

  async userById(id) {
    return clone(db.users.find((u) => u.userId === id)) || null;
  },

  async userByEmail(email) {
    return clone(db.users.find((u) => u.email === email)) || null;
  },

  async emailTaken(email) {
    return db.users.some((u) => u.email === email) || db.operators.some((o) => o.email === email);
  },

  async register(rest, admin) {
    db.restaurants.push(clone(rest));
    db.users.push(clone(admin));
    save();
  },

  async saveUser(u) {
    replace(db.users, 'userId', u);
    save();
  },

  async saveRestaurant(r) {
    replace(db.restaurants, 'restaurantId', r);
    save();
  },

  async setResetToken(userId, token, expiresAt) {
    db.resetTokens = db.resetTokens.filter((t) => t.userId !== userId);
    db.resetTokens.push({ tokenHash: sha256(token), userId, expiresAt });
    save();
  },

  async resetPassword(token, passwordHash) {
    const hash = sha256(token);
    const entry = db.resetTokens.find((t) => t.tokenHash === hash);
    if (!entry) return false;
    db.resetTokens = db.resetTokens.filter((t) => t !== entry);
    const user = db.users.find((u) => u.userId === entry.userId);
    if (new Date(entry.expiresAt) < new Date() || !user) {
      save();
      return false;
    }
    user.passwordHash = passwordHash;
    save();
    return true;
  },

  async operators(restaurantId, status) {
    return clone(db.operators.filter((o) => o.restaurantId === restaurantId && (!status || o.status === status)));
  },

  async countOperators(restaurantId) {
    return db.operators.filter((o) => o.restaurantId === restaurantId && o.status !== 'INACTIVE').length;
  },

  async operator(restaurantId, operatorId) {
    return clone(db.operators.find((o) => o.operatorId === operatorId && o.restaurantId === restaurantId)) || null;
  },

  async createOperator(o) {
    db.operators.push(clone(o));
    save();
    return clone(o);
  },

  async setOperatorStatus(restaurantId, operatorId, status) {
    const op = db.operators.find((o) => o.operatorId === operatorId && o.restaurantId === restaurantId);
    if (!op) return null;
    op.status = status;
    op.updatedAt = now();
    save();
    return clone(op);
  }
};
