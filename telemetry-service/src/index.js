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
const { pool } = require('./store');
// Con DATABASE_URL se usan las tablas relacionales; sin ella, el JSON local (desarrollo).
const repo = pool ? require('./pgrepo')(pool) : null;
const remote = { push() {} };

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
const memActiveProfile = ({ orderId, smartBoxId }) => {
  const list = db.profiles.filter((p) => p.active);
  if (orderId) return list.find((p) => p.orderId === orderId) || null;
  return list.filter((p) => p.smartBoxId === smartBoxId).pop() || null;
};
const activeProfile = async (q) => (repo ? repo.activeProfile(q) : memActiveProfile(q));

// Express 4 no captura rechazos de handlers async
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[TELEMETRY-SERVICE]', e.message);
  res.status(500).json({ error: 'Error interno de telemetría' });
});

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
app.post('/thermal-profiles', h(async (req, res) => {
  const { orderId, smartBoxId, type, minTemperature, maxTemperature } = req.body || {};
  if (!orderId || !smartBoxId || !THERMAL_DEFAULTS[type]) {
    return res.status(400).json({ error: 'orderId, smartBoxId y type (COLD|HOT) requeridos' });
  }
  const min = minTemperature ?? THERMAL_DEFAULTS[type].minTemperature;
  const max = maxTemperature ?? THERMAL_DEFAULTS[type].maxTemperature;
  if (Number(min) >= Number(max)) return res.status(400).json({ error: 'minTemperature debe ser menor que maxTemperature' });

  const id = normId(orderId);
  const data = { profileId: 'TP-' + id, orderId: id, smartBoxId, type, minTemperature: Number(min), maxTemperature: Number(max) };
  if (repo) return res.status(201).json(await repo.createProfile(data));

  // Una caja solo tiene un perfil activo a la vez
  db.profiles.forEach((p) => {
    if (p.active && (p.smartBoxId === smartBoxId || p.orderId === id)) p.active = false;
  });
  const profile = { ...data, active: true, createdAt: now() };
  db.profiles.push(profile);
  save();
  res.status(201).json(profile);
}));

app.get('/thermal-profiles', h(async (req, res) => {
  const { active } = req.query;
  if (repo) return res.json(await repo.listProfiles(active));
  res.json(db.profiles.filter((p) => active === undefined || String(p.active) === active));
}));

app.get('/thermal-profiles/orders/:orderId', h(async (req, res) => {
  const id = normId(req.params.orderId);
  const profile = repo ? await repo.profileByOrder(id) : db.profiles.filter((p) => p.orderId === id).pop();
  if (!profile) return res.status(404).json({ error: 'Perfil térmico no encontrado' });
  res.json(profile);
}));

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
app.post('/ingest', h(async (req, res) => {
  const { smartBoxId, shipmentId, temperature, lidOpen } = req.body || {};
  const temp = Number(temperature);
  if (!smartBoxId || temperature === undefined || !Number.isFinite(temp)) {
    return res.status(400).json({ error: 'smartBoxId y temperature (número) son obligatorios' });
  }

  const profile = await activeProfile({ orderId: normId(shipmentId), smartBoxId });
  const inRange = profile ? temp >= profile.minTemperature && temp <= profile.maxTemperature : null;
  const orderRef = profile?.orderId || normId(shipmentId) || 'UNASSIGNED';

  let log;
  if (repo) {
    log = await repo.insertReading({ smartBoxId, shipmentId: orderRef, temperature: temp, lidOpen: !!lidOpen, inRange });
  } else {
    log = {
      id: 'TLOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      smartBoxId,
      shipmentId: orderRef,
      temperature: temp,
      lidOpen: !!lidOpen,
      inRange,
      timestamp: now()
    };
    db.logs.unshift(log);
    if (db.logs.length > MAX_LOGS) db.logs.length = MAX_LOGS;
  }
  notifyLid(smartBoxId, log.shipmentId === 'UNASSIGNED' ? null : log.shipmentId, !!lidOpen);

  let alert = null;
  if (profile && !inRange) {
    // Una sola alerta abierta por envío: se actualiza con la última lectura
    const message = `Temperatura fuera de rango (${temp}°C, permitido ${profile.minTemperature}–${profile.maxTemperature}°C)`;
    if (repo) {
      alert = await repo.upsertBreach({ orderId: profile.orderId, smartBoxId, temperature: temp, min: profile.minTemperature, max: profile.maxTemperature, message });
    } else {
      alert = db.alerts.find((a) => a.orderId === profile.orderId && a.type === 'THERMAL_BREACH' && !a.resolved);
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
  }

  if (!repo) save();
  res.status(201).json({
    message: 'Telemetría recibida con éxito',
    log,
    evaluation: profile
      ? { profile: { type: profile.type, minTemperature: profile.minTemperature, maxTemperature: profile.maxTemperature }, status: inRange ? 'IN_RANGE' : 'THERMAL_BREACH' }
      : { status: 'NO_ACTIVE_PROFILE' },
    alert
  });
}));

// Consultas (lecturas más recientes primero)
const queryLogs = async ({ orderId, smartBoxId, limit }) =>
  repo
    ? repo.logs({ orderId: orderId ? normId(orderId) : null, smartBoxId, limit })
    : db.logs.filter((l) => (!orderId || l.shipmentId === normId(orderId)) && (!smartBoxId || l.smartBoxId === smartBoxId)).slice(0, limit);

app.get('/logs', h(async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const logs = await queryLogs({ ...req.query, limit });
  res.json({ total: logs.length, logs });
}));

app.get('/boxes/:boxId/current', h(async (req, res) => {
  const last = (await queryLogs({ smartBoxId: req.params.boxId, limit: 1 }))[0];
  if (!last) return res.status(404).json({ error: 'Sin lecturas para esta SmartBox' });
  res.json({ ...last, activeProfile: await activeProfile({ smartBoxId: req.params.boxId }) });
}));

app.get('/boxes/:boxId/history', h(async (req, res) => {
  const limit = Number(req.query.limit) || 60;
  const history = (await queryLogs({ smartBoxId: req.params.boxId, orderId: req.query.orderId, limit })).reverse();
  res.json({ smartBoxId: req.params.boxId, total: history.length, history });
}));

app.get('/alerts', h(async (req, res) => {
  const { resolved, orderId } = req.query;
  const limit = Number(req.query.limit) || 500;
  if (repo) return res.json(await repo.alerts({ resolved, orderId: orderId ? normId(orderId) : null, limit }));
  res.json(
    db.alerts
      .filter((a) => (resolved === undefined || String(a.resolved) === resolved) && (!orderId || a.orderId === normId(orderId)))
      .sort((x, y) => y.timestamp.localeCompare(x.timestamp))
      .slice(0, limit)
  );
}));

app.patch('/alerts/:alertId/resolve', h(async (req, res) => {
  let alert;
  if (repo) {
    alert = await repo.resolveAlert(req.params.alertId);
  } else {
    alert = db.alerts.find((a) => a.alertId === req.params.alertId);
    if (alert) {
      alert.resolved = true;
      alert.resolvedAt = now();
      save();
    }
  }
  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada' });
  res.json(alert);
}));

app.get('/health', (req, res) => {
  res.json({ service: 'telemetry-service', status: 'UP', timestamp: now() });
});

if (repo) {
  repo
    .seedIfEmpty(seed())
    .then((seeded) => console.log(`[TELEMETRY-SERVICE] PostgreSQL listo${seeded ? ' (datos iniciales cargados)' : ''}`))
    .catch((e) => console.error('[TELEMETRY-SERVICE] No se pudo inicializar PostgreSQL:', e.message));
}

app.listen(PORT, () => {
  console.log(`[TELEMETRY-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});