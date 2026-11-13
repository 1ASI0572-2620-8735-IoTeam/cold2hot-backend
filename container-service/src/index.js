const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());

const DATA_FILE = process.env.CONTAINER_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

const STATUSES = ['AVAILABLE', 'IN_TRANSIT', 'MAINTENANCE', 'DECOMMISSIONED'];
const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/;
const LOW_BATTERY_THRESHOLD = 15;

const seed = () => ({
  smartboxes: [
    { boxId: 'SB-014', serialNumber: 'C2H-SN-0014', macAddress: 'A4:CF:12:9B:3E:01', maxWeightKg: 8, status: 'IN_TRANSIT', deviceId: 'ESP32-014', batteryLevel: 82, isOnline: true, lastHeartbeat: new Date().toISOString() },
    { boxId: 'SB-022', serialNumber: 'C2H-SN-0022', macAddress: 'A4:CF:12:9B:3E:02', maxWeightKg: 8, status: 'IN_TRANSIT', deviceId: 'ESP32-022', batteryLevel: 64, isOnline: true, lastHeartbeat: new Date().toISOString() },
    { boxId: 'SB-007', serialNumber: 'C2H-SN-0007', macAddress: 'A4:CF:12:9B:3E:03', maxWeightKg: 10, status: 'AVAILABLE', deviceId: 'ESP32-007', batteryLevel: 12, isOnline: true, lastHeartbeat: new Date().toISOString() },
    { boxId: 'SB-031', serialNumber: 'C2H-SN-0031', macAddress: 'A4:CF:12:9B:3E:04', maxWeightKg: 10, status: 'AVAILABLE', deviceId: null, batteryLevel: 100, isOnline: false, lastHeartbeat: null }
  ],
  alerts: []
});

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return seed();
  }
};

let db = load();
const remote = require('./store').attach('container', () => db, (d) => { db = d; });

const save = () => {
  remote.push();
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[CONTAINER-SERVICE] No se pudo persistir en disco:', e.message);
  }
};

const findBox = (boxId) => db.smartboxes.find((b) => b.boxId === boxId);
const nextBoxId = () => {
  const max = db.smartboxes.reduce((m, b) => Math.max(m, parseInt(b.boxId.replace('SB-', ''), 10) || 0), 0);
  return 'SB-' + String(max + 1).padStart(3, '0');
};

const boxSchema = {
  type: 'object',
  properties: {
    boxId: { type: 'string', example: 'SB-014' },
    serialNumber: { type: 'string', example: 'C2H-SN-0014' },
    macAddress: { type: 'string', example: 'A4:CF:12:9B:3E:01' },
    maxWeightKg: { type: 'number', example: 8 },
    status: { type: 'string', enum: STATUSES },
    deviceId: { type: 'string', nullable: true, example: 'ESP32-014' },
    batteryLevel: { type: 'number', example: 82 },
    isOnline: { type: 'boolean' },
    lastHeartbeat: { type: 'string', format: 'date-time', nullable: true }
  }
};

const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const boxIdParam = [{ name: 'boxId', in: 'path', required: true, schema: { type: 'string' }, example: 'SB-014' }];

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - Container & Device Management API',
    version: '1.0.0',
    description: 'Microservicio para el inventario de SmartBoxes, emparejamiento de ESP32 y latidos (batería/conectividad). US13, US14.'
  },
  components: { schemas: { SmartBox: boxSchema } },
  paths: {
    '/smartboxes': {
      get: { summary: 'Listar todas las SmartBoxes', responses: { 200: { description: 'Listado de cajas' } } },
      post: {
        summary: 'Registrar nueva SmartBox (US13)',
        requestBody: json({
          type: 'object',
          required: ['serialNumber', 'macAddress', 'maxWeightKg'],
          properties: {
            serialNumber: { type: 'string', example: 'C2H-SN-0040' },
            macAddress: { type: 'string', example: 'A4:CF:12:9B:3E:40' },
            maxWeightKg: { type: 'number', example: 8 }
          }
        }),
        responses: { 201: { description: 'Caja registrada' }, 400: { description: 'Datos inválidos' }, 409: { description: 'Serie o MAC duplicada' } }
      }
    },
    '/smartboxes/available': {
      get: { summary: 'Cajas disponibles para despacho (AVAILABLE y batería >= 15%)', responses: { 200: { description: 'Cajas disponibles' } } }
    },
    '/smartboxes/{boxId}': {
      get: { summary: 'Detalle de una SmartBox', parameters: boxIdParam, responses: { 200: { description: 'Caja' }, 404: { description: 'No encontrada' } } }
    },
    '/smartboxes/{boxId}/pair-device': {
      post: {
        summary: 'Emparejar ESP32 con una SmartBox',
        parameters: boxIdParam,
        requestBody: json({ type: 'object', required: ['deviceId'], properties: { deviceId: { type: 'string', example: 'ESP32-040' } } }),
        responses: { 200: { description: 'Dispositivo emparejado' }, 404: { description: 'Caja no encontrada' }, 409: { description: 'Dispositivo ya emparejado a otra caja' } }
      }
    },
    '/smartboxes/{boxId}/status': {
      patch: {
        summary: 'Cambiar estado de la caja (US14)',
        parameters: boxIdParam,
        requestBody: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: STATUSES } } }),
        responses: { 200: { description: 'Estado actualizado' }, 400: { description: 'Estado inválido' }, 404: { description: 'Caja no encontrada' } }
      }
    },
    '/devices/heartbeat': {
      post: {
        summary: 'Latido del ESP32: batería y conectividad. Genera alerta LOW_BATTERY si < 15% (US14)',
        requestBody: json({
          type: 'object',
          required: ['batteryLevel'],
          properties: {
            boxId: { type: 'string', example: 'SB-014' },
            deviceId: { type: 'string', example: 'ESP32-014' },
            batteryLevel: { type: 'number', example: 13 }
          }
        }),
        responses: { 200: { description: 'Latido registrado' }, 404: { description: 'Caja/dispositivo no encontrado' } }
      }
    },
    '/alerts': {
      get: { summary: 'Alertas de batería baja generadas por este servicio', responses: { 200: { description: 'Alertas' } } }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/smartboxes', (req, res) => {
  res.json(db.smartboxes);
});

app.get('/smartboxes/available', (req, res) => {
  res.json(db.smartboxes.filter((b) => b.status === 'AVAILABLE' && b.batteryLevel >= LOW_BATTERY_THRESHOLD));
});

app.get('/smartboxes/:boxId', (req, res) => {
  const box = findBox(req.params.boxId);
  if (!box) return res.status(404).json({ error: 'SmartBox no encontrada' });
  res.json(box);
});

app.post('/smartboxes', (req, res) => {
  const { serialNumber, macAddress, maxWeightKg } = req.body || {};
  const errors = {};
  if (!serialNumber || !String(serialNumber).trim()) errors.serialNumber = 'Número de serie requerido';
  if (!macAddress || !MAC_REGEX.test(macAddress)) errors.macAddress = 'Formato MAC inválido (XX:XX:XX:XX:XX:XX)';
  const weight = Number(maxWeightKg);
  if (!Number.isFinite(weight) || weight <= 0) errors.maxWeightKg = 'Peso máximo debe ser mayor a 0';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });

  const serial = String(serialNumber).trim();
  const mac = macAddress.toUpperCase();
  if (db.smartboxes.some((b) => b.serialNumber === serial)) {
    return res.status(409).json({ error: 'El número de serie ya está registrado' });
  }
  if (db.smartboxes.some((b) => b.macAddress === mac)) {
    return res.status(409).json({ error: 'La dirección MAC ya está registrada' });
  }

  const box = {
    boxId: nextBoxId(),
    serialNumber: serial,
    macAddress: mac,
    maxWeightKg: weight,
    status: 'AVAILABLE',
    deviceId: null,
    batteryLevel: 100,
    isOnline: false,
    lastHeartbeat: null
  };
  db.smartboxes.push(box);
  save();
  res.status(201).json(box);
});

app.post('/smartboxes/:boxId/pair-device', (req, res) => {
  const box = findBox(req.params.boxId);
  if (!box) return res.status(404).json({ error: 'SmartBox no encontrada' });
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId requerido' });
  const other = db.smartboxes.find((b) => b.deviceId === deviceId && b.boxId !== box.boxId);
  if (other) return res.status(409).json({ error: `El dispositivo ya está emparejado con ${other.boxId}` });

  box.deviceId = deviceId;
  save();
  res.json(box);
});

app.patch('/smartboxes/:boxId/status', (req, res) => {
  const box = findBox(req.params.boxId);
  if (!box) return res.status(404).json({ error: 'SmartBox no encontrada' });
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `Estado inválido. Valores permitidos: ${STATUSES.join(', ')}` });
  }
  if (box.status === 'DECOMMISSIONED') {
    return res.status(400).json({ error: 'Una caja dada de baja no puede cambiar de estado' });
  }
  box.status = status;
  save();
  res.json(box);
});

app.post('/devices/heartbeat', (req, res) => {
  const { boxId, deviceId, batteryLevel } = req.body || {};
  const box = boxId ? findBox(boxId) : db.smartboxes.find((b) => deviceId && b.deviceId === deviceId);
  if (!box) return res.status(404).json({ error: 'SmartBox o dispositivo no encontrado' });

  const level = Number(batteryLevel);
  if (!Number.isFinite(level) || level < 0 || level > 100) {
    return res.status(400).json({ error: 'batteryLevel debe estar entre 0 y 100' });
  }

  box.batteryLevel = level;
  box.isOnline = true;
  box.lastHeartbeat = new Date().toISOString();

  let alert = null;
  if (level < LOW_BATTERY_THRESHOLD) {
    const open = db.alerts.find((a) => a.boxId === box.boxId && a.type === 'LOW_BATTERY' && !a.resolved);
    if (open) {
      open.batteryLevel = level;
      open.timestamp = box.lastHeartbeat;
      alert = open;
    } else {
      alert = {
        alertId: 'ALT-BAT-' + Date.now(),
        type: 'LOW_BATTERY',
        severity: 'WARNING',
        boxId: box.boxId,
        batteryLevel: level,
        resolved: false,
        timestamp: box.lastHeartbeat
      };
      db.alerts.push(alert);
    }
  } else {
    // Batería recuperada: cerrar alertas abiertas
    db.alerts.forEach((a) => {
      if (a.boxId === box.boxId && a.type === 'LOW_BATTERY' && !a.resolved) a.resolved = true;
    });
  }

  save();
  res.json({ smartBox: box, alert });
});

app.get('/alerts', (req, res) => {
  res.json(db.alerts);
});

app.patch('/alerts/:alertId/resolve', (req, res) => {
  const alert = db.alerts.find((a) => a.alertId === req.params.alertId);
  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada' });
  alert.resolved = true;
  save();
  res.json(alert);
});

app.get('/health', (req, res) => {
  res.json({ service: 'container-service', status: 'UP', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[CONTAINER-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});