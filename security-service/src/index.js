const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3004;

app.use(cors());
app.use(express.json());

const DEFAULT_OTP_TTL_MIN = 60;
const now = () => new Date().toISOString();

// Con DATABASE_URL se usan las tablas relacionales; sin ella, el JSON local (desarrollo).
const { pool } = require('./store');
const repo = pool ? require('./pgrepo') : require('./memrepo');

const ready = repo.init().then(
  (msg) => console.log(`[SECURITY-SERVICE] ${pool ? 'PostgreSQL' : 'Persistencia local'}: ${msg}`),
  (e) => {
    console.error('[SECURITY-SERVICE] No se pudo inicializar la base de datos:', e.message);
    throw e;
  }
);
ready.catch(() => {});

// Express 4 no captura rechazos de handlers async
const h = (fn) => async (req, res) => {
  try {
    await ready;
    await fn(req, res);
  } catch (e) {
    console.error('[SECURITY-SERVICE]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno de seguridad' });
  }
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

app.post('/otp', h(async (req, res) => {
  const { orderId, smartBoxId, ttlMinutes } = req.body || {};
  if (!orderId || !smartBoxId) return res.status(400).json({ error: 'orderId y smartBoxId requeridos' });
  const ttl = Number(ttlMinutes) > 0 ? Number(ttlMinutes) : DEFAULT_OTP_TTL_MIN;
  res.status(201).json(await repo.issueOtp({ orderId, smartBoxId, ttlMinutes: ttl }));
}));

// Consulta del OTP vigente de un envío (soporte al cliente)
app.get('/otp', h(async (req, res) => {
  if (!req.query.orderId) return res.status(400).json({ error: 'orderId requerido' });
  const otp = await repo.latestOtp(req.query.orderId);
  if (!otp) return res.status(404).json({ error: 'Sin OTP para este envío' });
  const state = otp.used ? 'USED' : otp.revoked ? 'REVOKED' : new Date(otp.expiresAt) < new Date() ? 'EXPIRED' : 'ACTIVE';
  res.json({ orderId: otp.orderId, code: otp.code, state, createdAt: otp.createdAt, expiresAt: otp.expiresAt });
}));

app.post('/otp/validate', h(async (req, res) => {
  const { orderId, smartBoxId, code } = req.body || {};
  if (!smartBoxId || !code) return res.status(400).json({ error: 'smartBoxId y code requeridos' });
  const { result, otp } = await repo.checkOtp({ orderId, smartBoxId, code, action: 'VALIDATE', consume: false });
  res.json({ result, orderId: otp?.orderId || orderId || null, smartBoxId });
}));

app.post('/unlock', h(async (req, res) => {
  const { orderId, smartBoxId, code } = req.body || {};
  if (!smartBoxId || !code) return res.status(400).json({ error: 'smartBoxId y code requeridos' });
  const { result, otp, lock } = await repo.checkOtp({ orderId, smartBoxId, code, action: 'UNLOCK', consume: true });
  if (result !== 'AUTHORIZED') return res.status(403).json({ result, lockState: lock.lockState });
  res.json({ result, lockState: lock.lockState, orderId: otp.orderId, smartBoxId });
}));

app.get('/locks/:smartBoxId', h(async (req, res) => {
  res.json(await repo.lock(req.params.smartBoxId));
}));

// Eventos de sensores (2 niveles)
app.post('/tamper-events', h(async (req, res) => {
  const { smartBoxId, orderId, lidOpen, packagePresent, forced } = req.body || {};
  if (!smartBoxId || typeof lidOpen !== 'boolean') {
    return res.status(400).json({ error: 'smartBoxId y lidOpen (boolean) requeridos' });
  }
  res.status(201).json(await repo.recordTamper({ smartBoxId, orderId, lidOpen, packagePresent, forced }));
}));

app.get('/tamper-events', h(async (req, res) => {
  res.json(await repo.events(req.query));
}));

app.get('/access-attempts', h(async (req, res) => {
  res.json(await repo.attempts(req.query));
}));

// Alertas
app.get('/alerts', h(async (req, res) => {
  res.json(await repo.alerts(req.query));
}));

app.patch('/alerts/:alertId/resolve', h(async (req, res) => {
  const alert = await repo.resolveAlert(req.params.alertId);
  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada' });
  res.json(alert);
}));

app.get('/health', (req, res) => {
  res.json({ service: 'security-service', status: 'UP', timestamp: now() });
});

app.listen(PORT, () => {
  console.log(`[SECURITY-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});
