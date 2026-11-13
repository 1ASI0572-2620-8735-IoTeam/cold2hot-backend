const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3005;
const CONTAINER_URL = process.env.CONTAINER_SERVICE_URL || 'http://localhost:3003';
const SECURITY_URL = process.env.SECURITY_SERVICE_URL || 'http://localhost:3004';
const TELEMETRY_URL = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:3002';
const DATA_FILE = process.env.ORDERS_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

app.use(cors());
app.use(express.json());

// ---------- Persistencia en archivo JSON ----------
const load = () => {
  try {
    return { shipments: [], ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch {
    return { shipments: [] };
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

const call = async (method, url, body) => {
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000)
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 503, data: null };
  }
};

const nextShipmentId = () => {
  const max = db.shipments.reduce((m, s) => Math.max(m, parseInt(s.shipmentId.replace('C2H-', ''), 10) || 0), 10480);
  return 'C2H-' + (max + 1);
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
    title: 'Cold2Hot - Orders & Audit Microservice API',
    version: '1.0.0',
    description: 'Creación de envíos con perfil térmico Cold/Hot, asignación de SmartBox, generación de OTP y reportes de auditoría.'
  },
  paths: {
    '/shipments': {
      post: {
        summary: 'Crear envío (asigna caja y genera OTP)',
        requestBody: json({
          customerAddress: { type: 'string', example: 'Av. Arequipa 1450, Miraflores' },
          thermalMode: { type: 'string', enum: ['COLD', 'HOT'] },
          minTemp: { type: 'number', example: 65 },
          maxTemp: { type: 'number', example: 80 },
          smartBoxId: { type: 'string', example: 'SB-014' },
          operatorName: { type: 'string', example: 'Diego R.' }
        }),
        responses: { 201: { description: 'Envío creado con OTP' }, 400: { description: 'Datos inválidos' }, 409: { description: 'Caja no disponible' }, 503: { description: 'Servicio dependiente no disponible' } }
      },
      get: {
        summary: 'Listar envíos (filtro: status)',
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['IN_TRANSIT', 'DELIVERED', 'CANCELLED'] } }],
        responses: { 200: { description: 'OK' } }
      }
    },
    '/shipments/{id}': { get: { summary: 'Detalle de envío', parameters: idParam, responses: { 200: { description: 'OK' }, 404: { description: 'No encontrado' } } } },
    '/shipments/{id}/complete': { patch: { summary: 'Marcar envío como entregado y liberar la caja', parameters: idParam, responses: { 200: { description: 'OK' }, 404: { description: 'No encontrado' }, 409: { description: 'Ya finalizado' } } } },
    '/audit/reports': {
      get: {
        summary: 'Reportes de auditoría por envío (filtros: from, to, shipmentId)',
        responses: { 200: { description: 'Trazabilidad térmica y eventos de acceso' } }
      }
    }
  }
};
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ---------- Endpoints ----------
app.post('/shipments', async (req, res) => {
  const { customerAddress, thermalMode, minTemp, maxTemp, smartBoxId, operatorName } = req.body || {};
  const errors = {};
  if (!customerAddress || !String(customerAddress).trim()) errors.customerAddress = 'Dirección requerida';
  if (!['COLD', 'HOT'].includes(thermalMode)) errors.thermalMode = 'Perfil térmico debe ser COLD o HOT';
  const min = Number(minTemp);
  const max = Number(maxTemp);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) errors.range = 'Rango térmico inválido (mínimo < máximo)';
  if (!smartBoxId) errors.smartBoxId = 'SmartBox requerida';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });

  const box = await call('GET', `${CONTAINER_URL}/smartboxes/${encodeURIComponent(smartBoxId)}`);
  if (box.status === 404) return res.status(400).json({ error: 'SmartBox no encontrada' });
  if (!box.ok) return res.status(503).json({ error: 'Servicio de contenedores no disponible' });
  if (box.data.status !== 'AVAILABLE') return res.status(409).json({ error: `La SmartBox ${smartBoxId} no está disponible (${box.data.status})` });

  if (box.data.batteryLevel < 15) return res.status(409).json({ error: `La SmartBox ${smartBoxId} tiene batería baja (${box.data.batteryLevel}%)` });

  const shipmentId = nextShipmentId();
  const otp = await call('POST', `${SECURITY_URL}/otp`, { orderId: shipmentId, smartBoxId });
  if (!otp.ok) return res.status(503).json({ error: 'No se pudo generar el OTP (servicio de seguridad no disponible)' });

  const marked = await call('PATCH', `${CONTAINER_URL}/smartboxes/${encodeURIComponent(smartBoxId)}/status`, { status: 'IN_TRANSIT' });
  if (!marked.ok) return res.status(503).json({ error: 'No se pudo reservar la SmartBox' });

  const shipment = {
    shipmentId,
    customerAddress: String(customerAddress).trim(),
    thermalMode,
    minTemp: min,
    maxTemp: max,
    smartBoxId,
    operatorName: operatorName || 'Sin asignar',
    status: 'IN_TRANSIT',
    otpCode: otp.data.code,
    otpExpiresAt: otp.data.expiresAt,
    createdAt: new Date().toISOString(),
    deliveredAt: null
  };
  db.shipments.unshift(shipment);
  save();
  res.status(201).json(shipment);
});

app.get('/shipments', (req, res) => {
  const { status } = req.query;
  res.json(db.shipments.filter((s) => !status || s.status === status));
});

app.get('/shipments/:id', (req, res) => {
  const s = db.shipments.find((x) => x.shipmentId === req.params.id);
  if (!s) return res.status(404).json({ error: 'Envío no encontrado' });
  res.json(s);
});

app.patch('/shipments/:id/complete', async (req, res) => {
  const s = db.shipments.find((x) => x.shipmentId === req.params.id);
  if (!s) return res.status(404).json({ error: 'Envío no encontrado' });
  if (s.status !== 'IN_TRANSIT') return res.status(409).json({ error: 'El envío ya fue finalizado' });
  s.status = 'DELIVERED';
  s.deliveredAt = new Date().toISOString();
  await call('PATCH', `${CONTAINER_URL}/smartboxes/${encodeURIComponent(s.smartBoxId)}/status`, { status: 'AVAILABLE' });
  save();
  res.json(s);
});

app.get('/audit/reports', async (req, res) => {
  const { from, to, shipmentId } = req.query;
  const list = db.shipments.filter(
    (s) => (!shipmentId || s.shipmentId === shipmentId) && (!from || s.createdAt >= from) && (!to || s.createdAt <= to)
  );

  const reports = await Promise.all(
    list.map(async (s) => {
      const [hist, attempts, tamper, alerts] = await Promise.all([
        call('GET', `${TELEMETRY_URL}/shipments/${s.shipmentId}/history`),
        call('GET', `${SECURITY_URL}/access-attempts?orderId=${s.shipmentId}`),
        call('GET', `${SECURITY_URL}/tamper-events?orderId=${s.shipmentId}`),
        call('GET', `${TELEMETRY_URL}/alerts?shipmentId=${s.shipmentId}`)
      ]);
      const readings = Array.isArray(hist.data) ? hist.data : [];
      const temps = readings.map((r) => r.temperature);
      const thermalAlerts = Array.isArray(alerts.data) ? alerts.data : [];
      const breaches = temps.filter((t) => t < s.minTemp || t > s.maxTemp).length;
      return {
        ...s,
        thermal: {
          readings: readings.length,
          min: temps.length ? Math.min(...temps) : null,
          max: temps.length ? Math.max(...temps) : null,
          average: temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10 : null,
          breaches,
          compliant: breaches === 0
        },
        accessAttempts: Array.isArray(attempts.data) ? attempts.data : [],
        tamperEvents: Array.isArray(tamper.data) ? tamper.data : [],
        thermalAlerts
      };
    })
  );
  res.json(reports);
});

app.get('/health', (req, res) => {
  res.json({ service: 'orders-service', status: 'UP', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[ORDERS-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});
