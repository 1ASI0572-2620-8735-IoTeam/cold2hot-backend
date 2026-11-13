const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3004;

app.use(cors());
app.use(express.json());

const DATA_FILE = process.env.SECURITY_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const DEFAULT_OTP_TTL_MIN = 60;
const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 };

const emptyDb = () => ({ otps: [], locks: {}, accessAttempts: [], tamperEvents: [], alerts: [] });

const load = () => {
  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch {
    return emptyDb();
  }
};

let db = load();
const remote = require('./store').attach('security', () => db, (d) => { db = d; });

const save = () => {
  remote.push();
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[SECURITY-SERVICE] No se pudo persistir en disco:', e.message);
  }
};

const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const getLock = (smartBoxId) => {
  if (!db.locks[smartBoxId]) db.locks[smartBoxId] = { smartBoxId, lockState: 'LOCKED', orderId: null, updatedAt: now() };
  return db.locks[smartBoxId];
};

const createAlert = ({ type, severity, smartBoxId, orderId, message }) => {
  const alert = { alertId: newId('ALT-SEC'), type, severity, smartBoxId, orderId: orderId || null, message, resolved: false, timestamp: now() };
  db.alerts.push(alert);
  return alert;
};

const evaluateOtp = ({ orderId, smartBoxId, code }) => {
  const candidates = db.otps.filter(
    (o) => o.smartBoxId === smartBoxId && (!orderId || o.orderId === orderId) && o.code === String(code)
  );
  const otp = candidates[candidates.length - 1];
  if (!otp) return { result: 'INVALID_CODE', otp: null };
  if (otp.used) return { result: 'ALREADY_USED', otp };
  if (otp.revoked) return { result: 'INVALID_CODE', otp };
  if (new Date(otp.expiresAt) < new Date()) return { result: 'EXPIRED_CODE', otp };
  return { result: 'AUTHORIZED', otp };
};

const logAttempt = ({ smartBoxId, orderId, code, result, action }) => {
  const attempt = {
    attemptId: newId('ATT'),
    smartBoxId,
    orderId: orderId || null,
    codeMasked: code ? '****' + String(code).slice(-2) : null,
    action,
    result,
    timestamp: now()
  };
  db.accessAttempts.push(attempt);
  return attempt;
};

// Swagger
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const otpBody = {
  type: 'object',
  required: ['smartBoxId', 'code'],
  properties: {
    orderId: { type: 'string', example: '#C2H-10482' },
    smartBoxId: { type: 'string', example: 'SB-014' },
    code: { type: 'string', example: '123456' }
  }
};

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - Access & Security API',
    version: '1.0.0',
    description: 'Microservicio para códigos OTP, desbloqueo del cerrojo y detección de aperturas no autorizadas. US06, US07, US16, US17.'
  },
  paths: {
    '/otp': {
      post: {
        summary: 'Generar OTP de 6 dígitos para un envío (revoca el anterior del mismo envío)',
        requestBody: json({
          type: 'object',
          required: ['orderId', 'smartBoxId'],
          properties: {
            orderId: { type: 'string', example: '#C2H-10482' },
            smartBoxId: { type: 'string', example: 'SB-014' },
            ttlMinutes: { type: 'number', example: 60 }
          }
        }),
        responses: { 201: { description: 'OTP generado' }, 400: { description: 'Datos inválidos' } }
      }
    },
    '/otp/validate': {
      post: {
        summary: 'Validar OTP sin desbloquear (AUTHORIZED, INVALID_CODE, EXPIRED_CODE, ALREADY_USED)',
        requestBody: json(otpBody),
        responses: { 200: { description: 'Resultado de la validación' } }
      }
    },
    '/unlock': {
      post: {
        summary: 'Validar OTP, consumirlo y cambiar el cerrojo a UNLOCKED',
        requestBody: json(otpBody),
        responses: { 200: { description: 'Desbloqueado' }, 403: { description: 'OTP rechazado' } }
      }
    },
    '/locks/{smartBoxId}': {
      get: {
        summary: 'Estado actual del cerrojo',
        parameters: [{ name: 'smartBoxId', in: 'path', required: true, schema: { type: 'string' }, example: 'SB-014' }],
        responses: { 200: { description: 'Estado del cerrojo' } }
      }
    },
    '/tamper-events': {
      post: {
        summary: 'Evento de sensores de la caja. Lógica de 2 niveles: LID_OPEN (WARNING) o UNAUTHORIZED_ACCESS (CRITICAL)',
        requestBody: json({
          type: 'object',
          required: ['smartBoxId', 'lidOpen'],
          properties: {
            smartBoxId: { type: 'string', example: 'SB-014' },
            orderId: { type: 'string', example: '#C2H-10482' },
            lidOpen: { type: 'boolean', example: true },
            packagePresent: { type: 'boolean', example: false },
            forced: { type: 'boolean', example: false }
          }
        }),
        responses: { 201: { description: 'Evento registrado (con alerta si corresponde)' } }
      },
      get: {
        summary: 'Listar eventos de sensores (filtros: orderId, smartBoxId)',
        parameters: [
          { name: 'orderId', in: 'query', schema: { type: 'string' } },
          { name: 'smartBoxId', in: 'query', schema: { type: 'string' } }
        ],
        responses: { 200: { description: 'Eventos' } }
      }
    },
    '/access-attempts': {
      get: {
        summary: 'Bitácora de intentos OTP (filtros: orderId, smartBoxId)',
        parameters: [
          { name: 'orderId', in: 'query', schema: { type: 'string' } },
          { name: 'smartBoxId', in: 'query', schema: { type: 'string' } }
        ],
        responses: { 200: { description: 'Intentos' } }
      }
    },
    '/alerts': {
      get: {
        summary: 'Alertas de seguridad ordenadas por severidad (filtros: resolved, type, orderId)',
        parameters: [
          { name: 'resolved', in: 'query', schema: { type: 'boolean' } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['UNAUTHORIZED_ACCESS', 'LID_OPEN'] } },
          { name: 'orderId', in: 'query', schema: { type: 'string' } }
        ],
        responses: { 200: { description: 'Alertas' } }
      }
    },
    '/alerts/{alertId}/resolve': {
      patch: {
        summary: 'Marcar alerta como atendida',
        parameters: [{ name: 'alertId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Alerta resuelta' }, 404: { description: 'No encontrada' } }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Filtro común por query
const byQuery = (list, q) =>
  list.filter((x) => (!q.orderId || x.orderId === q.orderId) && (!q.smartBoxId || x.smartBoxId === q.smartBoxId));

app.post('/otp', (req, res) => {
  const { orderId, smartBoxId, ttlMinutes } = req.body || {};
  if (!orderId || !smartBoxId) return res.status(400).json({ error: 'orderId y smartBoxId requeridos' });
  const ttl = Number(ttlMinutes) > 0 ? Number(ttlMinutes) : DEFAULT_OTP_TTL_MIN;

  // Revocar OTPs previos no usados del mismo envío
  db.otps.forEach((o) => {
    if (o.orderId === orderId && !o.used) o.revoked = true;
  });

  const otp = {
    otpId: newId('OTP'),
    code: generateCode(),
    orderId,
    smartBoxId,
    used: false,
    revoked: false,
    createdAt: now(),
    expiresAt: new Date(Date.now() + ttl * 60000).toISOString()
  };
  db.otps.push(otp);
  save();
  res.status(201).json(otp);
});

// Consulta del OTP vigente de un envío (soporte al cliente)
app.get('/otp', (req, res) => {
  const id = String(req.query.orderId || '').replace(/^#/, '');
  if (!id) return res.status(400).json({ error: 'orderId requerido' });
  const otp = [...db.otps].reverse().find((o) => String(o.orderId).replace(/^#/, '') === id);
  if (!otp) return res.status(404).json({ error: 'Sin OTP para este envío' });
  const state = otp.used ? 'USED' : otp.revoked ? 'REVOKED' : new Date(otp.expiresAt) < new Date() ? 'EXPIRED' : 'ACTIVE';
  res.json({ orderId: otp.orderId, code: otp.code, state, createdAt: otp.createdAt, expiresAt: otp.expiresAt });
});

app.post('/otp/validate', (req, res) => {
  const { orderId, smartBoxId, code } = req.body || {};
  if (!smartBoxId || !code) return res.status(400).json({ error: 'smartBoxId y code requeridos' });
  const { result, otp } = evaluateOtp({ orderId, smartBoxId, code });
  logAttempt({ smartBoxId, orderId: orderId || otp?.orderId, code, result, action: 'VALIDATE' });
  save();
  res.json({ result, orderId: otp?.orderId || orderId || null, smartBoxId });
});

app.post('/unlock', (req, res) => {
  const { orderId, smartBoxId, code } = req.body || {};
  if (!smartBoxId || !code) return res.status(400).json({ error: 'smartBoxId y code requeridos' });
  const { result, otp } = evaluateOtp({ orderId, smartBoxId, code });
  logAttempt({ smartBoxId, orderId: orderId || otp?.orderId, code, result, action: 'UNLOCK' });

  if (result !== 'AUTHORIZED') {
    save();
    return res.status(403).json({ result, lockState: getLock(smartBoxId).lockState });
  }

  otp.used = true;
  otp.usedAt = now();
  const lock = getLock(smartBoxId);
  lock.lockState = 'UNLOCKED';
  lock.orderId = otp.orderId;
  lock.updatedAt = now();
  save();
  res.json({ result, lockState: lock.lockState, orderId: otp.orderId, smartBoxId });
});

app.get('/locks/:smartBoxId', (req, res) => {
  res.json(getLock(req.params.smartBoxId));
});

// Eventos de sensores (2 niveles)
app.post('/tamper-events', (req, res) => {
  const { smartBoxId, orderId, lidOpen, packagePresent, forced } = req.body || {};
  if (!smartBoxId || typeof lidOpen !== 'boolean') {
    return res.status(400).json({ error: 'smartBoxId y lidOpen (boolean) requeridos' });
  }

  const lock = getLock(smartBoxId);
  const authorized = lock.lockState === 'UNLOCKED' && !forced;
  const event = {
    eventId: newId('EVT'),
    smartBoxId,
    orderId: orderId || lock.orderId || null,
    lidOpen,
    packagePresent: packagePresent ?? null,
    forced: !!forced,
    authorized: lidOpen ? authorized : null,
    timestamp: now()
  };
  db.tamperEvents.push(event);

  let alert = null;
  if (!lidOpen) {
    // Tapa cerrada: se vuelve a bloquear el cerrojo
    lock.lockState = 'LOCKED';
    lock.updatedAt = now();
  } else if (!authorized) {
    if (forced || packagePresent === false) {
      alert = createAlert({
        type: 'UNAUTHORIZED_ACCESS',
        severity: 'CRITICAL',
        smartBoxId,
        orderId: event.orderId,
        message: forced ? 'Apertura forzada detectada' : 'Tapa abierta sin OTP válido y paquete ausente'
      });
    } else {
      alert = createAlert({
        type: 'LID_OPEN',
        severity: 'WARNING',
        smartBoxId,
        orderId: event.orderId,
        message: 'Tapa abierta sin OTP válido con paquete presente (aviso preventivo)'
      });
    }
  }

  save();
  res.status(201).json({ event, alert, lockState: lock.lockState });
});

app.get('/tamper-events', (req, res) => {
  res.json(byQuery(db.tamperEvents, req.query));
});

app.get('/access-attempts', (req, res) => {
  res.json(byQuery(db.accessAttempts, req.query));
});

// Alertas
app.get('/alerts', (req, res) => {
  const { resolved, type, orderId } = req.query;
  const list = db.alerts
    .filter((a) => (resolved === undefined || String(a.resolved) === resolved) && (!type || a.type === type) && (!orderId || a.orderId === orderId))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.timestamp.localeCompare(a.timestamp));
  res.json(list);
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
  res.json({ service: 'security-service', status: 'UP', timestamp: now() });
});

app.listen(PORT, () => {
  console.log(`[SECURITY-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});