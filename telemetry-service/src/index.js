const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3002;
const ORDERS_URL = process.env.ORDERS_SERVICE_URL || 'http://localhost:3005';
const SECURITY_URL = process.env.SECURITY_SERVICE_URL || 'http://localhost:3004';
const DATA_FILE = process.env.TELEMETRY_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const MAX_LOGS = 5000;

app.use(cors());
app.use(express.json());

// ---------- Persistencia en archivo JSON ----------
const load = () => {
  try {
    return { logs: [], alerts: [], lidState: {}, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch {
    return { logs: [], alerts: [], lidState: {} };
  }
};
let db = load();
let saveTimer = null;
const save = () => {
  // Debounce: la ingesta puede ser frecuente
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(db));
    } catch (e) {
      console.warn('[TELEMETRY-SERVICE] No se pudo persistir en disco:', e.message);
    }
  }, 500);
};

const getJson = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};
const postJson = async (url, body) => {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500)
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

// ---------- OpenAPI ----------
const json = (properties) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties } } }
});
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'C2H-10482' }];
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - Telemetry & Thermal Microservice API',
    version: '2.0.0',
    description: 'Ingesta, consulta por envío y motor de alertas térmicas de sensores DS18B20.'
  },
  paths: {
    '/ingest': {
      post: {
        summary: 'Ingesta de lectura térmica (ESP32/Edge)',
        requestBody: json({
          smartBoxId: { type: 'string', example: 'SB-014' },
          shipmentId: { type: 'string', example: 'C2H-10482' },
          temperature: { type: 'number', example: 68.5 },
          lidOpen: { type: 'boolean', example: false }
        }),
        responses: { 201: { description: 'Lectura registrada (y alerta si hay desvío)' }, 400: { description: 'Datos inválidos' } }
      }
    },
    '/logs': { get: { summary: 'Últimas lecturas', responses: { 200: { description: 'OK' } } } },
    '/shipments/{id}/latest': { get: { summary: 'Última lectura de un envío', parameters: idParam, responses: { 200: { description: 'OK' }, 404: { description: 'Sin lecturas' } } } },
    '/shipments/{id}/history': { get: { summary: 'Serie térmica de un envío', parameters: idParam, responses: { 200: { description: 'OK' } } } },
    '/alerts': { get: { summary: 'Alertas térmicas (filtros: resolved, shipmentId)', responses: { 200: { description: 'OK' } } } },
    '/alerts/{id}/resolve': { patch: { summary: 'Resolver alerta', parameters: idParam, responses: { 200: { description: 'OK' }, 404: { description: 'No encontrada' } } } }
  }
};
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ---------- Motor de alertas ----------
const raiseAlert = ({ type, severity, shipmentId, smartBoxId, message }) => {
  const open = db.alerts.find((a) => a.shipmentId === shipmentId && a.type === type && !a.resolved);
  if (open) {
    open.message = message;
    open.timestamp = new Date().toISOString();
    return open;
  }
  const alert = {
    alertId: 'ALT-TEMP-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    type,
    severity,
    shipmentId,
    smartBoxId,
    message,
    resolved: false,
    timestamp: new Date().toISOString()
  };
  db.alerts.push(alert);
  return alert;
};

// ---------- Endpoints ----------
app.post('/ingest', async (req, res) => {
  const { smartBoxId, shipmentId, temperature, lidOpen } = req.body || {};
  const temp = Number(temperature);
  if (!smartBoxId || temperature === undefined || temperature === null || !Number.isFinite(temp)) {
    return res.status(400).json({ error: 'smartBoxId y temperature (numérico) son obligatorios' });
  }

  const log = {
    id: 'TLOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    smartBoxId,
    shipmentId: shipmentId || 'UNASSIGNED',
    temperature: temp,
    lidOpen: !!lidOpen,
    timestamp: new Date().toISOString()
  };
  db.logs.push(log);
  if (db.logs.length > MAX_LOGS) db.logs.splice(0, db.logs.length - MAX_LOGS);

  // Evaluar el rango térmico del envío
  let alert = null;
  if (shipmentId) {
    const shipment = await getJson(`${ORDERS_URL}/shipments/${encodeURIComponent(shipmentId)}`);
    if (shipment && shipment.status === 'IN_TRANSIT' && (temp < shipment.minTemp || temp > shipment.maxTemp)) {
      const limit = temp < shipment.minTemp ? `inferior al límite mínimo permitido (${shipment.minTemp}°C)` : `superior al límite máximo permitido (${shipment.maxTemp}°C)`;
      alert = raiseAlert({
        type: 'TEMP_BREACH',
        severity: 'CRITICAL',
        shipmentId,
        smartBoxId,
        message: `Desvío térmico: temperatura actual (${temp.toFixed(1)}°C) ${limit}.`
      });
    }
  }

  // Reenviar cambios de estado de la tapa al servicio de seguridad (detección de apertura no autorizada)
  if (typeof lidOpen === 'boolean' && db.lidState[smartBoxId] !== lidOpen) {
    db.lidState[smartBoxId] = lidOpen;
    postJson(`${SECURITY_URL}/tamper-events`, { smartBoxId, orderId: shipmentId, lidOpen });
  }

  save();
  res.status(201).json({ message: 'Telemetría recibida con éxito', log, alert });
});

app.get('/logs', (req, res) => {
  const logs = db.logs.slice(-100).reverse();
  res.json({ total: db.logs.length, logs });
});

app.get('/shipments/:id/latest', (req, res) => {
  const last = [...db.logs].reverse().find((l) => l.shipmentId === req.params.id);
  if (!last) return res.status(404).json({ error: 'Sin lecturas para el envío' });
  res.json(last);
});

app.get('/shipments/:id/history', (req, res) => {
  const { from, to } = req.query;
  const limit = Number.parseInt(req.query.limit, 10);
  let history = db.logs.filter(
    (l) => l.shipmentId === req.params.id && (!from || l.timestamp >= from) && (!to || l.timestamp <= to)
  );
  if (limit > 0) history = history.slice(-limit); // solo las últimas N lecturas
  res.json(history);
});

app.get('/alerts', (req, res) => {
  const { resolved, shipmentId, severity } = req.query;
  const list = db.alerts
    .filter(
      (a) =>
        (resolved === undefined || String(a.resolved) === resolved) &&
        (!shipmentId || a.shipmentId === shipmentId) &&
        (!severity || a.severity === severity)
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limit = Number.parseInt(req.query.limit, 10);
  res.json(limit > 0 ? list.slice(0, limit) : list);
});

app.patch('/alerts/:id/resolve', (req, res) => {
  const alert = db.alerts.find((a) => a.alertId === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada' });
  alert.resolved = true;
  alert.resolvedAt = new Date().toISOString();
  save();
  res.json(alert);
});

app.get('/health', (req, res) => {
  res.json({ service: 'telemetry-service', status: 'UP', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[TELEMETRY-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});
