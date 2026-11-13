const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json({ limit: '8mb' })); // fotos en Base64 (hasta 5 MB de imagen)

// URLs de otros microservicios (inyectadas por el orquestador / docker-compose)
const CONTAINER_URL = process.env.CONTAINER_SERVICE_URL || 'http://localhost:3003';
const SECURITY_URL = process.env.SECURITY_SERVICE_URL || 'http://localhost:3004';
const TELEMETRY_URL = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:3002';

const ACTIVE_STATUSES = ['CREATED', 'IN_TRANSIT'];
const THERMAL_DEFAULTS = { COLD: { minTemperature: 0, maxTemperature: 8 }, HOT: { minTemperature: 55, maxTemperature: 75 } };

const now = () => new Date().toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const normId = (id) => String(id || '').replace(/^#/, '');

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

// Con DATABASE_URL se usan las tablas relacionales; sin ella, el JSON local (desarrollo).
const { pool } = require('./store');
const repo = pool ? require('./pgrepo') : require('./memrepo');
const storage = require('./storage');

// Las peticiones esperan a que las tablas estén listas
const ready = repo.init(seed()).then(
  (msg) => console.log(`[ORDERS-SERVICE] ${pool ? 'PostgreSQL' : 'Persistencia local'}: ${msg}`),
  (e) => {
    console.error('[ORDERS-SERVICE] No se pudo inicializar la base de datos:', e.message);
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
    console.error('[ORDERS-SERVICE]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno de envíos' });
  }
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
            photoBase64: { type: 'string', description: 'Alternativa a photoUrl (data:image/jpeg;base64,...). Se sube a Supabase Storage y la respuesta devuelve su photoUrl. JPEG, PNG o WebP, máx. 5 MB' }
          }
        }),
        responses: { 200: { description: 'Entrega completada' }, 400: { description: 'Falta la foto' }, 409: { description: 'El envío no está en curso' } }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Helpers de custodia
const list = (r) => (r.ok && Array.isArray(r.data) ? r.data : []);

// Alertas de security (aperturas) + telemetry (desvío térmico) de un envío
const securityAlertsFor = async (orderId) => {
  const [s, t] = await Promise.all([
    call(`${SECURITY_URL}/alerts?orderId=${encodeURIComponent(orderId)}`),
    call(`${TELEMETRY_URL}/alerts?orderId=${encodeURIComponent(orderId)}`)
  ]);
  return [...list(s), ...list(t)];
};

// Todas las alertas agrupadas por envío: 2 llamadas en total en vez de 2 por envío
const alertsByOrder = async () => {
  const [s, t] = await Promise.all([call(`${SECURITY_URL}/alerts`), call(`${TELEMETRY_URL}/alerts?limit=10000`)]);
  const map = new Map();
  for (const a of [...list(s), ...list(t)]) {
    const id = normId(a.orderId);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(a);
  }
  return map;
};

const custodyStatus = (order, alerts = []) => {
  if (alerts.some((a) => a.type === 'UNAUTHORIZED_ACCESS') || order.incidents.includes('UNAUTHORIZED_ACCESS')) return 'UNAUTHORIZED_ACCESS';
  if (alerts.some((a) => a.type === 'THERMAL_BREACH') || order.incidents.includes('THERMAL_BREACH')) return 'THERMAL_BREACH';
  return 'VERIFIED';
};

const validDate = (d) => !d || (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)));

// Endpoints (las rutas fijas van ANTES de /:orderId)
app.get('/', h(async (req, res) => {
  const { custody, from, to } = req.query;
  if (!validDate(from) || !validDate(to)) return res.status(400).json({ error: 'from y to deben tener formato YYYY-MM-DD' });
  let orders = await repo.list(req.query);
  if (custody) {
    const alerts = await alertsByOrder();
    orders = orders.filter((o) => custodyStatus(o, alerts.get(o.orderId)) === custody);
  }
  res.json(orders);
}));

app.get('/health', (req, res) => {
  res.json({ service: 'orders-service', status: 'UP', storage: storage.enabled ? 'supabase' : 'inline', timestamp: now() });
});

app.get('/active', h(async (req, res) => {
  res.json(await repo.active());
}));

app.post('/', h(async (req, res) => {
  const { customerName, deliveryAddress, smartBoxId, operatorId, operatorName, thermalProfile } = req.body || {};
  const errors = {};
  if (!customerName) errors.customerName = 'Cliente requerido';
  if (!deliveryAddress) errors.deliveryAddress = 'Dirección requerida';
  if (!smartBoxId) errors.smartBoxId = 'SmartBox requerida';
  if (!operatorId) errors.operatorId = 'Operador requerido';
  const type = thermalProfile?.type;
  if (!THERMAL_DEFAULTS[type]) errors.thermalProfile = 'type debe ser COLD o HOT';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });

  const minTemperature = Number(thermalProfile.minTemperature ?? THERMAL_DEFAULTS[type].minTemperature);
  const maxTemperature = Number(thermalProfile.maxTemperature ?? THERMAL_DEFAULTS[type].maxTemperature);
  if (!Number.isFinite(minTemperature) || !Number.isFinite(maxTemperature) || minTemperature >= maxTemperature) {
    return res.status(400).json({ error: 'minTemperature debe ser menor que maxTemperature' });
  }
  const profile = { type, minTemperature, maxTemperature };

  // 1. Validar la SmartBox con container-service (si está disponible)
  const box = await call(`${CONTAINER_URL}/smartboxes/${encodeURIComponent(smartBoxId)}`);
  if (box.status === 404) return res.status(404).json({ error: 'SmartBox no encontrada' });
  if (box.ok) {
    if (box.data.status !== 'AVAILABLE') return res.status(409).json({ error: `SmartBox no disponible (estado ${box.data.status})` });
    if (box.data.batteryLevel < 15) return res.status(409).json({ error: 'SmartBox con batería menor a 15%' });
  }

  // 2. Guardar el envío (la base garantiza un solo envío en curso por caja)
  let order;
  try {
    order = await repo.create({ customerName, deliveryAddress, smartBoxId, operatorId, operatorName: operatorName || operatorId, thermalProfile: profile, status: 'IN_TRANSIT' });
  } catch (e) {
    if (e.code === 'BOX_BUSY') return res.status(409).json({ error: 'La SmartBox ya tiene un envío en curso' });
    throw e;
  }

  // 3. Marcar la caja en tránsito, registrar perfil térmico y emitir OTP
  const [, tp, otp] = await Promise.all([
    call(`${CONTAINER_URL}/smartboxes/${encodeURIComponent(smartBoxId)}/status`, { method: 'PATCH', body: { status: 'IN_TRANSIT' } }),
    call(`${TELEMETRY_URL}/thermal-profiles`, { method: 'POST', body: { orderId: order.orderId, smartBoxId, ...profile } }),
    call(`${SECURITY_URL}/otp`, { method: 'POST', body: { orderId: order.orderId, smartBoxId } })
  ]);

  res.status(201).json({
    ...order,
    otp: otp.ok ? { code: otp.data.code, expiresAt: otp.data.expiresAt } : null,
    warnings: [!box.ok && 'container-service no disponible: caja no validada', !otp.ok && 'security-service no disponible: OTP no emitido', !tp.ok && 'telemetry-service no disponible: perfil térmico no registrado'].filter(Boolean)
  });
}));

app.get('/analytics/operators', h(async (req, res) => {
  const month = req.query.month || now().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month debe tener formato YYYY-MM' });
  const [orders, alerts] = await Promise.all([repo.deliveredInMonth(month), alertsByOrder()]);

  const stats = {};
  for (const o of orders) {
    const s = (stats[o.operatorId] ||= { operatorId: o.operatorId, operatorName: o.operatorName, totalDeliveries: 0, perfectDeliveries: 0, incidentDeliveries: 0 });
    s.totalDeliveries++;
    if (custodyStatus(o, alerts.get(o.orderId)) === 'VERIFIED') s.perfectDeliveries++;
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
}));

// Arma el reporte juntando datos de telemetry y security
const buildAuditReport = async (order) => {
  const [telemetry, attempts, events, alerts] = await Promise.all([
    call(`${TELEMETRY_URL}/logs?orderId=${encodeURIComponent(order.orderId)}&limit=1000`),
    call(`${SECURITY_URL}/access-attempts?orderId=${encodeURIComponent(order.orderId)}`),
    call(`${SECURITY_URL}/tamper-events?orderId=${encodeURIComponent(order.orderId)}`),
    securityAlertsFor(order.orderId)
  ]);
  const logs = telemetry.ok ? telemetry.data.logs || [] : [];
  const thermalHistory = logs.filter((l) => normId(l.shipmentId) === order.orderId).reverse();

  return {
    orderId: order.orderId,
    smartBoxId: order.smartBoxId,
    operator: { operatorId: order.operatorId, operatorName: order.operatorName },
    thermalProfile: order.thermalProfile,
    thermalHistory,
    accessAttempts: list(attempts),
    openingEvents: list(events),
    securityAlerts: alerts,
    evidence: order.evidence || { status: 'PENDING_SYNC', message: 'Evidencia pendiente de sincronización' },
    custodyStatus: custodyStatus(order, alerts),
    orderStatus: order.status
  };
};

app.get('/audits/:orderId', h(async (req, res) => {
  const id = normId(req.params.orderId);
  const stored = await repo.audit(id);
  if (stored) return res.json(stored);
  const order = await repo.find(id, { withPhoto: true });
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  res.json({ consolidated: false, ...(await buildAuditReport(order)) });
}));

app.post('/audits/:orderId', h(async (req, res) => {
  const order = await repo.find(normId(req.params.orderId), { withPhoto: true });
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  const existing = await repo.audit(order.orderId);
  if (existing) return res.status(409).json({ error: 'El reporte ya fue consolidado y es inmutable', report: existing });

  const body = await buildAuditReport(order);
  const report = {
    reportId: 'AUD-' + order.orderId,
    consolidated: true,
    generatedAt: now(),
    ...body
  };
  report.integrityHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const saved = await repo.saveAudit(report);
  if (!saved) return res.status(409).json({ error: 'El reporte ya fue consolidado y es inmutable', report: await repo.audit(order.orderId) });
  res.status(201).json(saved);
}));

app.get('/:orderId', h(async (req, res) => {
  const order = await repo.find(normId(req.params.orderId), { withPhoto: true });
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  res.json(order);
}));

app.post('/:orderId/evidence', h(async (req, res) => {
  const order = await repo.find(normId(req.params.orderId));
  if (!order) return res.status(404).json({ error: 'Envío no encontrado' });
  const { photoUrl, photoBase64 } = req.body || {};
  if (!photoUrl && !photoBase64) return res.status(400).json({ error: 'photoUrl o photoBase64 requerido' });
  if (photoUrl && !/^https?:\/\//i.test(photoUrl)) return res.status(400).json({ error: 'photoUrl debe ser una URL http(s)' });
  if (!ACTIVE_STATUSES.includes(order.status)) return res.status(409).json({ error: `El envío no está en curso (estado ${order.status})` });

  // La foto en Base64 se sube a Supabase Storage; en la base solo queda su URL
  let evidence = { photoUrl };
  if (photoBase64) {
    const image = storage.parseImage(photoBase64);
    if (image.error) return res.status(400).json({ error: image.error });
    if (storage.enabled) {
      try {
        evidence = await storage.uploadEvidence(order.orderId, image);
      } catch (e) {
        console.error('[ORDERS-SERVICE] Falló la subida a Storage:', e.message);
        return res.status(502).json({ error: 'No se pudo guardar la foto de evidencia. Intenta nuevamente.' });
      }
    } else {
      evidence = { photoBase64: `data:${image.contentType};base64,${image.buffer.toString('base64')}`, contentType: image.contentType, sizeBytes: image.buffer.length };
    }
  }

  const delivered = await repo.deliver(order.orderId, evidence);
  if (!delivered) {
    await storage.removeEvidence(evidence.storagePath);
    return res.status(409).json({ error: 'El envío ya no está en curso' });
  }

  // Liberar la SmartBox
  const freed = await call(`${CONTAINER_URL}/smartboxes/${encodeURIComponent(order.smartBoxId)}/status`, { method: 'PATCH', body: { status: 'AVAILABLE' } });
  res.json({ ...delivered, smartBoxReleased: freed.ok });
}));

// Fotos que quedaron en Base64 (Storage sin configurar en su momento) se suben al arrancar
if (storage.enabled) {
  ready
    .then(async () => {
      await storage.ensureBucket();
      const pending = await repo.pendingPhotos();
      for (const p of pending) {
        const image = storage.parseImage(p.photoBase64);
        if (image.error) continue;
        await repo.movePhotoToStorage(p.orderId, await storage.uploadEvidence(p.orderId, image));
      }
      console.log(`[ORDERS-SERVICE] Supabase Storage listo (bucket ${storage.BUCKET}${pending.length ? `, ${pending.length} foto(s) migradas` : ''})`);
    })
    .catch((e) => console.warn('[ORDERS-SERVICE] Supabase Storage no disponible:', e.message));
} else if (pool) {
  console.warn('[ORDERS-SERVICE] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no definidas: las fotos se guardan en la base (Base64)');
}

app.listen(PORT, () => {
  console.log(`[ORDERS-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});
