/**
 * Repositorio en memoria + archivo JSON (solo desarrollo, cuando no hay DATABASE_URL).
 * Misma interfaz que pgrepo.js.
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.ORDERS_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const ACTIVE = ['CREATED', 'IN_TRANSIT'];
const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);
const now = () => new Date().toISOString();

let db = { orders: [], audits: {} };

const save = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[ORDERS-SERVICE] No se pudo persistir en disco:', e.message);
  }
};

// En los listados no viaja la foto en Base64 (puede pesar varios MB)
const view = (o, withPhoto) => {
  const copy = clone(o);
  if (copy.evidence && !withPhoto) delete copy.evidence.photoBase64;
  return copy;
};

module.exports = {
  async init(seed) {
    try {
      db = { audits: {}, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
      return 'archivo local cargado';
    } catch {
      db = seed;
      return 'datos iniciales en memoria';
    }
  },

  async list({ q, status, operator, smartBoxId, profile, from, to }) {
    return db.orders
      .filter((o) => {
        if (q && !`${o.orderId} ${o.customerName} ${o.deliveryAddress}`.toLowerCase().includes(q.replace(/^#/, '').toLowerCase())) return false;
        if (status && o.status !== status) return false;
        if (operator && o.operatorId !== operator && o.operatorName.toLowerCase() !== operator.toLowerCase()) return false;
        if (smartBoxId && o.smartBoxId !== smartBoxId) return false;
        if (profile && o.thermalProfile.type !== profile) return false;
        if (from && o.createdAt < from) return false;
        if (to && o.createdAt.slice(0, 10) > to) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => view(o));
  },

  async active() {
    return db.orders.filter((o) => ACTIVE.includes(o.status)).map((o) => view(o));
  },

  async find(orderId, { withPhoto = false } = {}) {
    const o = db.orders.find((x) => x.orderId === orderId);
    return o ? view(o, withPhoto) : null;
  },

  async boxBusy(smartBoxId) {
    return db.orders.some((o) => o.smartBoxId === smartBoxId && ACTIVE.includes(o.status));
  },

  async create(data) {
    if (await this.boxBusy(data.smartBoxId)) throw Object.assign(new Error('BOX_BUSY'), { code: 'BOX_BUSY' });
    const max = db.orders.reduce((m, o) => Math.max(m, parseInt(o.orderId.replace('C2H-', ''), 10) || 0), 10000);
    const order = { orderId: 'C2H-' + (max + 1), ...data, incidents: [], evidence: null, createdAt: now(), deliveredAt: null };
    db.orders.push(order);
    save();
    return view(order);
  },

  async deliveredInMonth(month) {
    return db.orders.filter((o) => o.status === 'DELIVERED' && (o.deliveredAt || o.createdAt).startsWith(month)).map((o) => view(o));
  },

  async deliver(orderId, evidence) {
    const o = db.orders.find((x) => x.orderId === orderId);
    if (!o || !ACTIVE.includes(o.status)) return null;
    o.evidence = { photoUrl: evidence.photoUrl || null, ...(evidence.photoBase64 ? { photoBase64: evidence.photoBase64 } : {}), uploadedAt: now() };
    o.status = 'DELIVERED';
    o.deliveredAt = now();
    save();
    return view(o, true);
  },

  async audit(orderId) {
    return clone(db.audits[orderId]) || null;
  },

  async saveAudit(report) {
    if (db.audits[report.orderId]) return null;
    db.audits[report.orderId] = report;
    save();
    return clone(report);
  },

  async pendingPhotos() {
    return [];
  },

  async movePhotoToStorage() {}
};
