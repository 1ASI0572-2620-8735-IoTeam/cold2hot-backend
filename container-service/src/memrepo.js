/**
 * Repositorio en memoria + archivo JSON (solo desarrollo, cuando no hay DATABASE_URL).
 * Misma interfaz que pgrepo.js.
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.CONTAINER_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);
let db = { smartboxes: [], alerts: [] };

const save = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[CONTAINER-SERVICE] No se pudo persistir en disco:', e.message);
  }
};
const findBox = (boxId) => db.smartboxes.find((b) => b.boxId === boxId);
const err = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

module.exports = {
  async init(seed) {
    try {
      db = { alerts: [], ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
      return 'archivo local cargado';
    } catch {
      db = seed;
      return 'datos iniciales en memoria';
    }
  },

  async list() {
    return clone(db.smartboxes);
  },

  async available(minBattery) {
    return clone(db.smartboxes.filter((b) => b.status === 'AVAILABLE' && b.batteryLevel >= minBattery));
  },

  async find(boxId) {
    return clone(findBox(boxId)) || null;
  },

  async create({ serialNumber, macAddress, maxWeightKg }) {
    if (db.smartboxes.some((b) => b.serialNumber === serialNumber)) throw err('SERIAL_TAKEN');
    if (db.smartboxes.some((b) => b.macAddress === macAddress)) throw err('MAC_TAKEN');
    const max = db.smartboxes.reduce((m, b) => Math.max(m, parseInt(b.boxId.replace('SB-', ''), 10) || 0), 0);
    const box = { boxId: 'SB-' + String(max + 1).padStart(3, '0'), serialNumber, macAddress, maxWeightKg, status: 'AVAILABLE', deviceId: null, batteryLevel: 100, isOnline: false, lastHeartbeat: null };
    db.smartboxes.push(box);
    save();
    return clone(box);
  },

  async pairDevice(boxId, deviceId) {
    const other = db.smartboxes.find((b) => b.deviceId === deviceId && b.boxId !== boxId);
    if (other) throw err('DEVICE_TAKEN', { other: other.boxId });
    const box = findBox(boxId);
    if (!box) return null;
    box.deviceId = deviceId;
    save();
    return clone(box);
  },

  async setStatus(boxId, status) {
    const box = findBox(boxId);
    if (!box) return null;
    box.status = status;
    save();
    return clone(box);
  },

  async heartbeat({ boxId, deviceId, batteryLevel, threshold }) {
    const box = boxId ? findBox(boxId) : db.smartboxes.find((b) => deviceId && b.deviceId === deviceId);
    if (!box) return null;
    box.batteryLevel = batteryLevel;
    box.isOnline = true;
    box.lastHeartbeat = new Date().toISOString();

    let alert = null;
    const open = db.alerts.find((a) => a.boxId === box.boxId && a.type === 'LOW_BATTERY' && !a.resolved);
    if (batteryLevel < threshold) {
      if (open) {
        Object.assign(open, { batteryLevel, timestamp: box.lastHeartbeat });
        alert = open;
      } else {
        alert = { alertId: 'ALT-BAT-' + Date.now(), type: 'LOW_BATTERY', severity: 'WARNING', boxId: box.boxId, batteryLevel, resolved: false, timestamp: box.lastHeartbeat };
        db.alerts.push(alert);
      }
    } else if (open) {
      open.resolved = true;
    }
    save();
    return { smartBox: clone(box), alert: clone(alert) };
  },

  async alerts() {
    return clone(db.alerts);
  },

  async resolveAlert(alertId) {
    const alert = db.alerts.find((a) => a.alertId === alertId);
    if (!alert) return null;
    alert.resolved = true;
    save();
    return clone(alert);
  }
};
