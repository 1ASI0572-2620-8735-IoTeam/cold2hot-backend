const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json({ limit: '5mb' })); // fotos en Base64

// URLs de otros microservicios (inyectadas por el orquestador / docker-compose)
const CONTAINER_URL = process.env.CONTAINER_SERVICE_URL || 'http://localhost:3003';
const SECURITY_URL = process.env.SECURITY_SERVICE_URL || 'http://localhost:3004';
const TELEMETRY_URL = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:3002';

const DATA_FILE = process.env.ORDERS_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const ACTIVE_STATUSES = ['CREATED', 'IN_TRANSIT'];
const THERMAL_DEFAULTS = { COLD: { minTemperature: 0, maxTemperature: 8 }, HOT: { minTemperature: 55, maxTemperature: 75 } };

const now = () => new Date().toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

const seed = () => ({
  orders: [
    { orderId: 'C2H-10482', customerName: 'María López', deliveryAddress: 'Av. Larco 345, Miraflores', smartBoxId: 'SB-014', operatorId: 'OP-001', operatorName: 'Carlos Ruiz', thermalProfile: { type: 'HOT', ...THERMAL_DEFAULTS.HOT }, status: 'IN_TRANSIT', incidents: [], evidence: null, createdAt: daysAgo(0), deliveredAt: null },
    { orderId: 'C2H-10483', customerName: 'Jorge Paredes', deliveryAddress: 'Calle Las Begonias 120, San Isidro', smartBoxId: 'SB-022', operatorId: 'OP-002', operatorName: 'Lucía Torres', thermalProfile: { type: 'COLD', ...THERMAL_DEFAULTS.COLD }, status: 'IN_TRANSIT', incidents: [], evidence: null, createdAt: daysAgo(0), deliveredAt: null },
    { orderId: 'C2H-10470', customerName: 'Ana Fernández', deliveryAddress: 'Jr. Ucayali 220, Cercado', smartBoxId: 'SB-007', operatorId: 'OP-001', operatorName: 'Carlos Ruiz', thermalProfile: { type: 'HOT', ...THERMAL_DEFAULTS.HOT }, status: 'DELIVERED', incidents: [], evidence: { photoUrl: 'https://picsum.photos/seed/c2h10470/600/400', uploadedAt: daysAgo(3) }, createdAt: daysAgo(3), deliveredAt: daysAgo(3) },
    { orderId: 'C2H-10471', customerName: 'Pedro Salas', deliveryAddress: 'Av. Benavides 1500, Surco', smartBoxId: 'SB-031', operatorId: 'OP-002', operatorName: 'Lucía Torres', thermalProfile: { type: 'COLD', ...THERMAL_DEFAULTS.COLD }, status: 'DELIVERED', incidents: ['THERMAL_BREACH'], evidence: { photoUrl: 'https://picsum.photos/seed/c2h10471/600/400', uploadedAt: daysAgo(2) }, createdAt: daysAgo(2), deliveredAt: daysAgo(2) },
    { orderId: 'C2H-10472', customerName: 'Rosa Quispe', deliveryAddress: 'Av. Arequipa 2100, Lince', smartBoxId: 'SB-007', operatorId: 'OP-003', operatorName: 'Diego Ramos', thermalProfile: { type: 'HOT', ...THERMAL_DEFAULTS.HOT }, status: 'DELIVERED', incidents: [], evidence: null, createdAt: daysAgo(1), deliveredAt: daysAgo(1) }
  ],
  audits: {}
});

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return seed();
  }
};

let db = load();

const save = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[ORDERS-SERVICE] No se pudo persistir en disco:', e.message);
  }
};

const findOrder = (orderId) => db.orders.find((o) => o.orderId === orderId.replace(/^#/, ''));
const nextOrderId = () => {
  const max = db.orders.reduce((m, o) => Math.max(m, parseInt(o.orderId.replace('C2H-', ''), 10) || 0), 10000);
  return 'C2H-' + (max + 1);
};

// Llamada HTTP a otro microservicio. Si está caído devuelve { ok:false } en vez de romper.
const call = async (url, options = {}) => {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(3000)
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
};

// Swagger
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const orderIdParam = [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' }, example: 'C2H-10482' }];

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - Orders & Audit API',
    version: '1.0.0',
    description: 'Microservicio de envíos, evidencia fotográfica de entrega, reportes de auditoría y analítica de repartidores. US03, US05, US08, US19.'
  },
  servers: [
    { url: '/api/v1/orders', description: 'Vía API Gateway (:8080)' },
    { url: 'http://localhost:3005', description: 'Directo al servicio' }
  ],

  paths: {
    '/': {
      get: {
        summary: 'Listar envíos (historial W09) con filtros',
        parameters: [
          { name: 'q', in: 'query', description: 'Busca por ID, cliente o dirección', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['CREATED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] } },
          { name: 'custody', in: 'query', schema: { type: 'string', enum: ['VERIFIED', 'THERMAL_BREACH', 'UNAUTHORIZED_ACCESS'] } },
          { name: 'operator', in: 'query', description: 'operatorId o nombre', schema: { type: 'string' } },
          { name: 'smartBoxId', in: 'query', schema: { type: 'string' } },
          { name: 'profile', in: 'query', schema: { type: 'string', enum: ['COLD', 'HOT'] } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, example: '2026-11-01' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, example: '2026-11-30' }
        ],
        responses: { 200: { description: 'Envíos' } }
      },
      post: {
        summary: 'Crear envío: asigna SmartBox y operador, guarda perfil térmico y emite OTP (US03)',
        requestBody: json({
          type: 'object',
          required: ['customerName', 'deliveryAddress', 'smartBoxId', 'operatorId', 'thermalProfile'],
          properties: {
            customerName: { type: 'string', example: 'Luis Gómez' },
            deliveryAddress: { type: 'string', example: 'Av. Pardo 610, Miraflores' },
            smartBoxId: { type: 'string', example: 'SB-031' },
            operatorId: { type: 'string', example: 'OP-003' },
            operatorName: { type: 'string', example: 'Diego Ramos' },
            thermalProfile: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['COLD', 'HOT'], example: 'COLD' },
                minTemperature: { type: 'number', example: 0 },
                maxTemperature: { type: 'number', example: 8 }
              }
            }
          }
        }),
        responses: { 201: { description: 'Envío creado (incluye OTP)' }, 400: { description: 'Datos inválidos' }, 409: { description: 'SmartBox no disponible' } }
      }
    },
    '/active': { get: { summary: 'Envíos activos (W04)', responses: { 200: { description: 'Envíos en curso' } } } },
    '/analytics/operators': {
      get: {
        summary: 'Rendimiento por repartidor en un mes (W13 / US19)',
        parameters: [{ name: 'month', in: 'query', schema: { type: 'string' }, example: '2026-11' }],
        responses: { 200: { description: 'KPIs por operador' } }
      }
    },
    '/audits/{orderId}': {
      get: { summary: 'Obtener reporte de auditoría (consolidado si existe; si no, vista previa en vivo)', parameters: orderIdParam, responses: { 200: { description: 'Reporte' }, 404: { description: 'Envío no encontrado' } } },
      post: { summary: 'Consolidar reporte de auditoría inmutable (US05)', parameters: orderIdParam, responses: { 201: { description: 'Reporte consolidado' }, 409: { description: 'Ya consolidado' } } }
    },
    '/{orderId}': { get: { summary: 'Detalle del envío', parameters: orderIdParam, responses: { 200: { description: 'Envío' }, 404: { description: 'No encontrado' } } } },
    '/{orderId}/evidence': {
      post: {
        summary: 'Subir foto de evidencia: marca DELIVERED y libera la SmartBox (US08)',
        parameters: orderIdParam,
        requestBody: json({
          type: 'object',
          properties: {
            photoUrl: { type: 'string', example: 'https://picsum.photos/seed/entrega/600/400' },
            photoBase64: { type: 'string', description: 'Alternativa a photoUrl (data:image/jpeg;base64,...)' }
          }
        }),
        responses: { 200: { description: 'Entrega completada' }, 400: { description: 'Falta la foto' }, 409: { description: 'El envío no está en curso' } }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Helpers de custodia
// Alertas de security (aperturas) + telemetry (desvío térmico) de un envío
const securityAlertsFor = async (orderId) => {
  const [r, r2, t] = await Promise.all([
    call(`${SECURITY_URL}/alerts?orderId=${encodeURIComponent(orderId)}`),
    call(`${SECURITY_URL}/alerts?orderId=${encodeURIComponent('#' + orderId)}`),
    call(`${TELEMETRY_URL}/alerts?orderId=${encodeURIComponent(orderId)}`)
  ]);
  return [...(r.ok ? r.data : []), ...(r2.ok ? r2.data : []), ...(t.ok ? t.data : [])];
};

const custodyStatus = (order, alerts = []) => {
  if (alerts.some((a) => a.type === 'UNAUTHORIZED_ACCESS') || order.incidents.includes('UNAUTHORIZED_ACCESS')) return 'UNAUTHORIZED_ACCESS';
  if (alerts.some((a) => a.type === 'THERMAL_BREACH') || order.incidents.includes('THERMAL_BREACH')) return 'THERMAL_BREACH';
  return 'VERIFIED';
};

// Endpoints (las rutas fijas van ANTES de /:orderId)
app.get('/', async (req, res) => {
  const { q, status, custody, operator, smartBoxId, profile, from, to } = req.query;
  let list = db.orders.filter((o) => {
    if (q && !`${o.orderId} ${o.customerName} ${o.deliveryAddress}`.toLowerCase().includes(q.replace(/^#/, '').toLowerCase())) return false;
    if (status && o.status !== status) return false;
    if (operator && o.operatorId !== operator && o.operatorName.toLowerCase() !== operator.toLowerCase()) return false;
    if (smartBoxId && o.smartBoxId !== smartBoxId) return false;
    if (profile && o.thermalProfile.type !== profile) return false;
    if (from && o.createdAt < from) return false;
    if (to && o.createdAt.slice(0, 10) > to) return false;
    return true;
  });

  if (custody) {
    const withAlerts = await Promise.all(list.map(async (o) => ({ o, c: custodyStatus(o, await securityAlertsFor(o.orderId)) })));
    list = withAlerts.filter((x) => x.c === custody).map((x) => x.o);
  }

  res.json(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get('/health', (req, res) => {
  res.json({ service: 'orders-service', status: 'UP', timestamp: now() });
});

app.get('/active', (req, res) => {
  res.json(db.orders.filter((o) => ACTIVE_STATUSES.includes(o.status)));
});

app.post('/', async (req, res) => {
  const { customerName, deliveryAddress, smartBoxId, operatorId, operatorName, thermalProfile } = req.body || {};
  const errors = {};
  if (!customerName) errors.customerName = 'Cliente requerido';
  if (!deliveryAddress) errors.deliveryAddress = 'Dirección requerida';
  if (!smartBoxId) errors.smartBoxId = 'SmartBox requerida';
  if (!operatorId) errors.operatorId = 'Operador requerido';
  const type = thermalProfile?.type;
  if (!THERMAL_DEFAULTS[type]) errors.thermalProfile = 'type debe ser COLD o HOT';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });

  const profile = { type, ...THERMAL_DEFAULTS[type], ...thermalProfile };
  if (profile.minTemperature >= profile.maxTemperature) {
    return res.status(400).json({ error: 'minTemperature debe ser menor que maxTemperature' });
  }

  // 1. Validar la SmartBox con container-service (si está disponible)
  const box = await call(`${CONTAINER_URL}/smartboxes/${encodeURIComponent(smartBoxId)}`);
  if (box.status === 404) return res.status(404).json({ error: 'SmartBox no encontrada' });
  if (box.ok) {
    if (box.data.status !== 'AVAILABLE') return res.status(409).json({ error: `SmartBox no disponible (estado ${box.data.status})` });
    if (box.data.batteryLevel < 15) return res.status(409).json({ error: 'SmartBox con batería menor a 15%' });
  }
  if (db.orders.some((o) => o.smartBoxId === smartBoxId && ACTIVE_STATUSES.includes(o.status))) {
    return res.status(409).json({ error: 'La SmartBox ya tiene un envío en curso' });
  }

  const order = {
    orderId: nextOrderId(),
    customerName,
    deliveryAddress,
    smartBoxId,
    operatorId,
    operatorName: operatorName || operatorId,
    thermalProfile: profile,
    status: 'IN_TRANSIT',
    incidents: [],
    evidence: null,
    createdAt: now(),
    deliveredAt: null
  };

  // 2. Marcar la caja en tránsito, registrar perfil térmico y emitir OTP
  await call(`${CONTAINER_URL}/smartboxes/${encodeURIComponent(smartBoxId)}/status`, { method: 'PATCH', body: { status: 'IN_TRANSIT' } });
  const tp = await call(`${TELEMETRY_URL}/thermal-profiles`, { method: 'POST', body: { orderId: order.orderId, smartBoxId, ...profile } });
  const otp = await call(`${SECURITY_URL}/otp`, { method: 'POST', body: { orderId: order.orderId, smartBoxId } });

  db.orders.push(order);
  save();
  res.status(201).json({
    ...order,
    otp: otp.ok ? { code: otp.data.code, expiresAt: otp.data.expiresAt } : null,
    warnings: [!box.ok && 'container-service no disponible: caja no validada', !otp.ok && 'security-service no disponible: OTP no emitido', !tp.ok && 'telemetry-service no disponible: perfil térmico no registrado'].filter(Boolean)
  });
});

app.get('/analytics/operators', async (req, res) => {
  const month = req.query.month || now().slice(0, 7);
  const orders = db.orders.filter((o) => o.status === 'DELIVERED' && (o.deliveredAt || o.createdAt).startsWith(month));

  const stats = {};
  for (const o of orders) {
    const s = (stats[o.operatorId] ||= { operatorId: o.operatorId, operatorName: o.operatorName, totalDeliveries: 0, perfectDeliveries: 0, incidentDeliveries: 0 });
    s.totalDeliveries++;
    const alerts = await securityAlertsFor(o.orderId);
    if (custodyStatus(o, alerts) === 'VERIFIED') s.perfectDeliveries++;
    else s.incidentDeliveries++;
  }

  const operators = Object.values(stats).map((s) => ({ ...s, compliancePercent: Math.round((s.perfectDeliveries / s.totalDeliveries) * 100) }));
  const total = operators.reduce((a, s) => a + s.totalDeliveries, 0);
  const perfect = operators.reduce((a, s) => a + s.perfectDeliveries, 0);
  res.json({
    month,
    fleet: { totalDeliveries: total, perfectDeliveries: perfect, compliancePercent: total ? Math.round((perfect / total) * 100) : 0 },
    operators: operators.sort((a, b) => b.compliancePercent - a.compliancePercent)
  });
});

// Arma el reporte juntando datos de telemetry y security
const buildAuditReport = async (order) => {
  const [telemetry, attempts, events, alerts] = await Promise.all([
    call(`${TELEMETRY_URL}/logs?orderId=${encodeURIComponent(order.orderId)}&limit=1000`),
    call(`${SECURITY_URL}/access-attempts?orderId=${encodeURIComponent(order.orderId)}`),
    call(`${SECURITY_URL}/tamper-events?orderId=${encodeURIComponent(order.orderId)}`),
    securityAlertsFor(order.orderId)
  ]);
  const logs = telemetry.ok ? telemetry.data.logs || [] : [];
  const thermalHistory = logs.filter((l) => l.shipmentId === order.orderId || l.shipmentId === '#' + order.orderId).reverse();

  return {
    orderId: order.orderId,
    smartBoxId: order.smartBoxId,
    operator: { operatorId: order.operatorId, operatorName: order.operatorName },
    thermalProfile: order.thermalProfile,
    thermalHistory,
    accessAttempts: attempts.ok ? attempts.data : [],
    openingEvents: events.ok ? events.data : [],
    securityAlerts: alerts,
    evidence: order.evidence || { status: 'PENDING_SYNC', message: 'Evidencia pendiente de sincronización' },
    custodyStatus: custodyStatus(order, alerts),
    orderStatus: order.status
  };
};

app.get('/audits/:orderId', async (req, res) => {
  const order = findOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  const stored = db.audits[order.orderId];
  if (stored) return res.json(stored);
  res.json({ consolidated: false, ...(await buildAuditReport(order)) });
});

app.post('/audits/:orderId', async (req, res) => {
  const order = findOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  if (db.audits[order.orderId]) return res.status(409).json({ error: 'El reporte ya fue consolidado y es inmutable', report: db.audits[order.orderId] });

  const body = await buildAuditReport(order);
  const report = {
    reportId: 'AUD-' + order.orderId,
    consolidated: true,
    generatedAt: now(),
    ...body
  };
  report.integrityHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  db.audits[order.orderId] = report;
  save();
  res.status(201).json(report);
});

app.get('/:orderId', (req, res) => {
  const order = findOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  res.json(order);
});

app.post('/:orderId/evidence', async (req, res) => {
  const order = findOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  const { photoUrl, photoBase64 } = req.body || {};
  if (!photoUrl && !photoBase64) return res.status(400).json({ error: 'photoUrl o photoBase64 requerido' });
  if (!ACTIVE_STATUSES.includes(order.status)) return res.status(409).json({ error: `El envío no está en curso (estado ${order.status})` });

  order.evidence = { photoUrl: photoUrl || null, photoBase64: photoBase64 || null, uploadedAt: now() };
  order.status = 'DELIVERED';
  order.deliveredAt = now();

  // Liberar la SmartBox
  const freed = await call(`${CONTAINER_URL}/smartboxes/${encodeURIComponent(order.smartBoxId)}/status`, { method: 'PATCH', body: { status: 'AVAILABLE' } });
  save();
  res.json({ ...order, smartBoxReleased: freed.ok });
});

app.listen(PORT, () => {
  console.log(`[ORDERS-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});