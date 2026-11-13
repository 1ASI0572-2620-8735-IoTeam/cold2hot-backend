/**
 * Repositorio en memoria + archivo JSON (solo desarrollo, cuando no hay DATABASE_URL).
 * Misma interfaz que pgrepo.js.
 */
const fs = require('fs');
const path = require('path');
const { newId, generateCode, maskCode, normId, evaluateOtp, classifyTamper, SEVERITY_ORDER } = require('./rules');

const DATA_FILE = process.env.SECURITY_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const now = () => new Date().toISOString();
const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);
const emptyDb = () => ({ otps: [], locks: {}, accessAttempts: [], tamperEvents: [], alerts: [] });

let db = emptyDb();

const save = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[SECURITY-SERVICE] No se pudo persistir en disco:', e.message);
  }
};

const getLock = (smartBoxId) => db.locks[smartBoxId] || { smartBoxId, lockState: 'LOCKED', orderId: null, updatedAt: null };
const setLock = (smartBoxId, patch) => {
  db.locks[smartBoxId] = { ...getLock(smartBoxId), ...patch, updatedAt: now() };
  return db.locks[smartBoxId];
};
const byQuery = (list, q) =>
  list.filter((x) => (!q.orderId || normId(x.orderId) === normId(q.orderId)) && (!q.smartBoxId || x.smartBoxId === q.smartBoxId));

module.exports = {
  async init() {
    try {
      db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
      return 'archivo local cargado';
    } catch {
      return 'datos en memoria';
    }
  },

  async issueOtp({ orderId, smartBoxId, ttlMinutes }) {
    const id = normId(orderId);
    db.otps.forEach((o) => {
      if (normId(o.orderId) === id && !o.used) o.revoked = true;
    });
    const otp = {
      otpId: newId('OTP'),
      code: generateCode(),
      orderId: id,
      smartBoxId,
      used: false,
      revoked: false,
      createdAt: now(),
      expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString()
    };
    db.otps.push(otp);
    save();
    return clone(otp);
  },

  async latestOtp(orderId) {
    const id = normId(orderId);
    return clone([...db.otps].reverse().find((o) => normId(o.orderId) === id)) || null;
  },

  async checkOtp({ orderId, smartBoxId, code, action, consume }) {
    const id = normId(orderId);
    const otp = db.otps.filter((o) => o.smartBoxId === smartBoxId && (!id || normId(o.orderId) === id) && o.code === String(code)).pop() || null;
    const result = evaluateOtp(otp);
    db.accessAttempts.push({ attemptId: newId('ATT'), smartBoxId, orderId: id || otp?.orderId || null, codeMasked: maskCode(code), action, result, timestamp: now() });

    let lock = getLock(smartBoxId);
    if (consume && result === 'AUTHORIZED') {
      otp.used = true;
      otp.usedAt = now();
      lock = setLock(smartBoxId, { lockState: 'UNLOCKED', orderId: otp.orderId });
    }
    save();
    return { result, otp: clone(otp), lock: clone(lock) };
  },

  async lock(smartBoxId) {
    return clone(getLock(smartBoxId));
  },

  async recordTamper({ smartBoxId, orderId, lidOpen, packagePresent, forced }) {
    const lock = getLock(smartBoxId);
    const decision = classifyTamper({ lock, lidOpen, packagePresent, forced });
    const ref = normId(orderId) || lock.orderId || null;
    const event = { eventId: newId('EVT'), smartBoxId, orderId: ref, lidOpen, packagePresent: packagePresent ?? null, forced: !!forced, authorized: decision.authorized, timestamp: now() };
    db.tamperEvents.push(event);

    let alert = null;
    if (decision.alert) {
      alert = { alertId: newId('ALT-SEC'), ...decision.alert, smartBoxId, orderId: ref, resolved: false, timestamp: now() };
      db.alerts.push(alert);
    }
    const lockState = decision.relock ? setLock(smartBoxId, { lockState: 'LOCKED' }).lockState : lock.lockState;
    save();
    return { event: clone(event), alert: clone(alert), lockState };
  },

  async events(q) {
    return clone(byQuery(db.tamperEvents, q));
  },

  async attempts(q) {
    return clone(byQuery(db.accessAttempts, q));
  },

  async alerts({ resolved, type, orderId }) {
    return clone(
      db.alerts
        .filter((a) => (resolved === undefined || String(a.resolved) === resolved) && (!type || a.type === type) && (!orderId || normId(a.orderId) === normId(orderId)))
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.timestamp.localeCompare(a.timestamp))
    );
  },

  async resolveAlert(alertId) {
    const alert = db.alerts.find((a) => a.alertId === alertId);
    if (!alert) return null;
    alert.resolved = true;
    alert.resolvedAt = alert.resolvedAt || now();
    save();
    return clone(alert);
  }
};
