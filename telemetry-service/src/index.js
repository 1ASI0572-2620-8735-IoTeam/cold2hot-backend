const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

const DATA_FILE = process.env.TELEMETRY_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const MAX_LOGS = 2000;
const THERMAL_DEFAULTS = { COLD: { minTemperature: 0, maxTemperature: 8 }, HOT: { minTemperature: 55, maxTemperature: 75 } };

const now = () => new Date().toISOString();
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const normId = (id) => (id ? String(id).replace(/^#/, '') : null);

// Curva térmica de ejemplo (una lectura por minuto)
const seedCurve = (smartBoxId, shipmentId, base, count, spikeAt = -1) =>
  Array.from({ length: count }, (_, i) => ({
    id: `TLOG-SEED-${shipmentId}-${i}`,
    smartBoxId,
    shipmentId,
    temperature: +(base + Math.sin(i / 2) * 1.5 + (i === spikeAt ? 9 : 0)).toFixed(1),
    lidOpen: false,
    inRange: i !== spikeAt,
    timestamp: minutesAgo(count - i)
  })).reverse();

const seed = () => ({
  profiles: [
    { profileId: 'TP-C2H-10482', orderId: 'C2H-10482', smartBoxId: 'SB-014', type: 'HOT', ...THERMAL_DEFAULTS.HOT, active: true, createdAt: minutesAgo(30) },
    { profileId: 'TP-C2H-10483', orderId: 'C2H-10483', smartBoxId: 'SB-022', type: 'COLD', ...THERMAL_DEFAULTS.COLD, active: true, createdAt: minutesAgo(30) },
    { profileId: 'TP-C2H-10471', orderId: 'C2H-10471', smartBoxId: 'SB-031', type: 'COLD', ...THERMAL_DEFAULTS.COLD, active: false, createdAt: minutesAgo(2880) }
  ],
  logs: [
    ...seedCurve('SB-014', 'C2H-10482', 66, 15),
    ...seedCurve('SB-022', 'C2H-10483', 4, 15),
    ...seedCurve('SB-031', 'C2H-10471', 5, 10, 6)
  ],
  alerts: [
    { alertId: 'ALT-TMP-SEED-1', type: 'THERMAL_BREACH', severity: 'CRITICAL', orderId: 'C2H-10471', smartBoxId: 'SB-031', temperature: 14.4, minTemperature: 0, maxTemperature: 8, message: 'Temperatura fuera de rango (14.4°C, permitido 0–8°C)', resolved: true, timestamp: minutesAgo(2875) }
  ]
});

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return seed();
  }
};

let db = load();
const remote = require('./store').attach('telemetry', () => db, (d) => { db = d; });

const save = () => {
  remote.push();
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[TELEMETRY-SERVICE] No se pudo persistir en disco:', e.message);
  }
};

// Perfil activo: por envío si viene; si no, el último activo de la caja
const activeProfile = ({ orderId, smartBoxId }) => {
  const list = db.profiles.filter((p) => p.active);
  if (orderId) return list.find((p) => p.orderId === orderId) || null;
  return list.filter((p) => p.smartBoxId === smartBoxId).pop() || null;
};

// Swagger
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const boxParam = { name: 'boxId', in: 'path', required: true, schema: { type: 'string' }, example: 'SB-014' };

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - Telemetry & Thermal Microservice API',
    version: '2.0.0',
    description: 'Perfiles térmicos, ingesta de lecturas DS18B20 cada minuto y detección automática de desvío térmico. US04, US09, US16.'
  },
  // URL relativa a /docs: funciona igual vía gateway (:8080) o directo al servicio
  servers: [
    { url: '/api/v1/telemetry', description: 'Vía API Gateway (:8080)' },
    { url: 'http://localhost:3002', description: 'Directo al servicio' }
  ],
  
  paths: {
    '/thermal-profiles': {
      post: {
        summary: 'Configurar perfil térmico de un envío (desactiva el perfil anterior de esa caja)',
        requestBody: json({
          type: 'object',
          required: ['orderId', 'smartBoxId', 'type'],
          properties: {
            orderId: { type: 'string', example: 'C2H-10490' },
            smartBoxId: { type: 'string', example: 'SB-031' },
            type: { type: 'string', enum: ['COLD', 'HOT'], example: 'COLD' },
            minTemperature: { type: 'number', example: 2 },
            maxTemperature: { type: 'number', example: 6 }
          }
        }),
        responses: { 201: { description: 'Perfil creado' }, 400: { description: 'Datos inválidos' } }
      },
      get: { summary: 'Listar perfiles térmicos (filtro: active)', parameters: [{ name: 'active', in: 'query', schema: { type: 'boolean' } }], responses: { 200: { description: 'Perfiles' } } }
    },
    '/thermal-profiles/orders/{orderId}': {
      get: {
        summary: 'Perfil térmico de un envío',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' }, example: 'C2H-10482' }],
        responses: { 200: { description: 'Perfil' }, 404: { description: 'No encontrado' } }
      }
    },
    '/ingest': {
      post: {
        summary: 'Ingesta de lectura desde ESP32/Edge. Evalúa contra el perfil activo y genera THERMAL_BREACH si sale de rango (US09)',
        requestBody: json({
          type: 'object',
          required: ['smartBoxId', 'temperature'],
          properties: {
            smartBoxId: { type: 'string', example: 'SB-014' },
            shipmentId: { type: 'string', example: 'C2H-10482', description: 'Opcional: si no viene se usa el perfil activo de la caja' },
            temperature: { type: 'number', example: 50.2 },
            lidOpen: { type: 'boolean', example: false }
          }
        }),
        responses: { 201: { description: 'Lectura guardada y evaluada' }, 400: { description: 'Datos inválidos' } }
      }
    },
    '/logs': {
      get: {
        summary: 'Listar lecturas (filtros: orderId, smartBoxId, limit)',
        parameters: [
          { name: 'orderId', in: 'query', schema: { type: 'string' } },
          { name: 'smartBoxId', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', example: 100 } }
        ],
        responses: { 200: { description: 'Lecturas' } }
      }
    },
    '/boxes/{boxId}/current': {
      get: { summary: 'Última lectura de una SmartBox + perfil activo', parameters: [boxParam], responses: { 200: { description: 'Lectura actual' }, 404: { description: 'Sin lecturas' } } }
    },
    '/boxes/{boxId}/history': {
      get: {
        summary: 'Historial térmico de una SmartBox (orden cronológico, para gráfica)',
        parameters: [boxParam, { name: 'orderId', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', example: 60 } }],
        responses: { 200: { description: 'Historial' } }
      }
    },
    '/alerts': {
      get: {
        summary: 'Alertas de desvío térmico (filtros: resolved, orderId)',
        parameters: [{ name: 'resolved', in: 'query', schema: { type: 'boolean' } }, { name: 'orderId', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'Alertas' } }
      }
    },
    '/alerts/{alertId}/resolve': {
      patch: {
        summary: 'Marcar alerta térmica como atendida',
        parameters: [{ name: 'alertId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Alerta resuelta' }, 404: { description: 'No encontrada' } }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Perfiles térmicos
app.post('/thermal-profiles', (req, res) => {
  const { orderId, smartBoxId, type, minTemperature, maxTemperature } = req.body || {};
  if (!orderId || !smartBoxId || !THERMAL_DEFAULTS[type]) {
    return res.status(400).json({ error: 'orderId, smartBoxId y type (COLD|HOT) requeridos' });
  }
  const min = minTemperature ?? THERMAL_DEFAULTS[type].minTemperature;
  const max = maxTemperature ?? THERMAL_DEFAULTS[type].maxTemperature;
  if (Number(min) >= Number(max)) return res.status(400).json({ error: 'minTemperature debe ser menor que maxTemperature' });

  const id = normId(orderId);
  // Una caja solo tiene un perfil activo a la vez
  db.profiles.forEach((p) => {
    if (p.active && (p.smartBoxId === smartBoxId || p.orderId === id)) p.active = false;
  });

  const profile = { profileId: 'TP-' + id, orderId: id, smartBoxId, type, minTemperature: Number(min), maxTemperature: Number(max), active: true, createdAt: now() };
  db.profiles.push(profile);
  save();
  res.status(201).json(profile);
});

app.get('/thermal-profiles', (req, res) => {
  const { active } = req.query;
  res.json(db.profiles.filter((p) => active === undefined || String(p.active) === active));
});

app.get('/thermal-profiles/orders/:orderId', (req, res) => {
  const id = normId(req.params.orderId);
  const profile = db.profiles.filter((p) => p.orderId === id).pop();
  if (!profile) return res.status(404).json({ error: 'Perfil térmico no encontrado' });
  res.json(profile);
});

// Aviso a security-service cuando cambia el estado de la tapa (apertura/cierre)
const SECURITY_URL = process.env.SECURITY_SERVICE_URL || 'http://localhost:3004';
const lastLid = {};
const notifyLid = (smartBoxId, orderId, lidOpen) => {
  if (lastLid[smartBoxId] === lidOpen || (lastLid[smartBoxId] === undefined && !lidOpen)) {
    lastLid[smartBoxId] = lidOpen;
    return;
  }
  lastLid[smartBoxId] = lidOpen;
  fetch(`${SECURITY_URL}/tamper-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ smartBoxId, orderId, lidOpen })
  }).catch(() => {});
};

// Ingesta + evaluación
app.post('/ingest', (req, res) => {
  const { smartBoxId, shipmentId, temperature, lidOpen } = req.body || {};
  const temp = Number(temperature);
  if (!smartBoxId || temperature === undefined || !Number.isFinite(temp)) {
    return res.status(400).json({ error: 'smartBoxId y temperature (número) son obligatorios' });
  }

  const profile = activeProfile({ orderId: normId(shipmentId), smartBoxId });
  const inRange = profile ? temp >= profile.minTemperature && temp <= profile.maxTemperature : null;

  const log = {
    id: 'TLOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    smartBoxId,
    shipmentId: profile?.orderId || normId(shipmentId) || 'UNASSIGNED',
    temperature: temp,
    lidOpen: !!lidOpen,
    inRange,
    timestamp: now()
  };
  db.logs.unshift(log);
  notifyLid(smartBoxId, log.shipmentId === 'UNASSIGNED' ? null : log.shipmentId, !!lidOpen);
  if (db.logs.length > MAX_LOGS) db.logs.length = MAX_LOGS;

  let alert = null;
  if (profile && !inRange) {
    // Una sola alerta abierta por envío: se actualiza con la última lectura
    alert = db.alerts.find((a) => a.orderId === profile.orderId && a.type === 'THERMAL_BREACH' && !a.resolved);
    const message = `Temperatura fuera de rango (${temp}°C, permitido ${profile.minTemperature}–${profile.maxTemperature}°C)`;
    if (alert) {
      Object.assign(alert, { temperature: temp, message, lastSeenAt: log.timestamp, readingsOutOfRange: (alert.readingsOutOfRange || 1) + 1 });
    } else {
      alert = {
        alertId: 'ALT-TMP-' + Date.now(),
        type: 'THERMAL_BREACH',
        severity: 'CRITICAL',
        orderId: profile.orderId,
        smartBoxId,
        temperature: temp,
        minTemperature: profile.minTemperature,
        maxTemperature: profile.maxTemperature,
        message,
        readingsOutOfRange: 1,
        resolved: false,
        timestamp: log.timestamp
      };
      db.alerts.push(alert);
    }
  }

  save();
  res.status(201).json({
    message: 'Telemetría recibida con éxito',
    log,
    evaluation: profile
      ? { profile: { type: profile.type, minTemperature: profile.minTemperature, maxTemperature: profile.maxTemperature }, status: inRange ? 'IN_RANGE' : 'THERMAL_BREACH' }
      : { status: 'NO_ACTIVE_PROFILE' },
    alert
  });
});

// Consultas
const filterLogs = ({ orderId, smartBoxId }) =>
  db.logs.filter((l) => (!orderId || l.shipmentId === normId(orderId)) && (!smartBoxId || l.smartBoxId === smartBoxId));

app.get('/logs', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const logs = filterLogs(req.query).slice(0, limit);
  res.json({ total: logs.length, logs });
});

app.get('/boxes/:boxId/current', (req, res) => {
  const last = filterLogs({ smartBoxId: req.params.boxId })[0];
  if (!last) return res.status(404).json({ error: 'Sin lecturas para esta SmartBox' });
  res.json({ ...last, activeProfile: activeProfile({ smartBoxId: req.params.boxId }) });
});

app.get('/boxes/:boxId/history', (req, res) => {
  const limit = Number(req.query.limit) || 60;
  const history = filterLogs({ smartBoxId: req.params.boxId, orderId: req.query.orderId }).slice(0, limit).reverse();
  res.json({ smartBoxId: req.params.boxId, total: history.length, history });
});

app.get('/alerts', (req, res) => {
  const { resolved, orderId } = req.query;
  res.json(
    db.alerts
      .filter((a) => (resolved === undefined || String(a.resolved) === resolved) && (!orderId || a.orderId === normId(orderId)))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  );
});

app.patch('/alerts/:alertId/resolve', (req, res) => {
  const alert = db.alerts.find((a) => a.alertId === req.params.alertId);
  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada' });
  alert.resolved = true;
  alert.resolvedAt = now();
  save();
  res.json(alert);
});

app.get('/health', (req, res) => {
  res.json({ service: 'telemetry-service', status: 'UP', timestamp: now() });
});

app.listen(PORT, () => {
  console.log(`[TELEMETRY-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});