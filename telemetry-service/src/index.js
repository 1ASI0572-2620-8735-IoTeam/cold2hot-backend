const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Memoria volátil / Caché de lecturas térmicas
let telemetryLogs = [
  { smartBoxId: 'SB-014', shipmentId: '#C2H-10482', temperature: 68.4, timestamp: new Date().toISOString() },
  { smartBoxId: 'SB-022', shipmentId: '#C2H-10483', temperature: 4.2, timestamp: new Date().toISOString() },
  { smartBoxId: 'SB-007', shipmentId: '#C2H-10484', temperature: 58.2, timestamp: new Date().toISOString() }
];

// Documentación OpenAPI / Swagger
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - Telemetry & Thermal Microservice API',
    version: '1.0.0',
    description: 'Microservicio Core para la ingesta y consulta de telemetría térmica de sensores DS18B20.'
  },
  paths: {
    '/ingest': {
      post: {
        summary: 'Ingesta de lectura térmica desde el Edge Service o ESP32',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  smartBoxId: { type: 'string', example: 'SB-014' },
                  shipmentId: { type: 'string', example: '#C2H-10482' },
                  temperature: { type: 'number', example: 68.5 },
                  lidOpen: { type: 'boolean', example: false }
                }
              }
            }
          }
        },
        responses: {
          201: { description: 'Telemetría persistida y evaluada' }
        }
      }
    },
    '/logs': {
      get: {
        summary: 'Listar registros recientes de telemetría',
        responses: {
          200: { description: 'Lista de lecturas recibidas' }
        }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Endpoints
app.post('/ingest', (req, res) => {
  const { smartBoxId, shipmentId, temperature, lidOpen } = req.body;

  if (temperature === undefined || !smartBoxId) {
    return res.status(400).json({ error: 'smartBoxId y temperature son obligatorios' });
  }

  const log = {
    id: 'TLOG-' + Date.now(),
    smartBoxId,
    shipmentId: shipmentId || 'UNASSIGNED',
    temperature,
    lidOpen: !!lidOpen,
    timestamp: new Date().toISOString()
  };

  telemetryLogs.unshift(log);
  if (telemetryLogs.length > 100) telemetryLogs.pop();

  res.status(201).json({
    message: 'Telemetría recibida con éxito',
    log
  });
});

app.get('/logs', (req, res) => {
  res.json({ total: telemetryLogs.length, logs: telemetryLogs });
});

app.get('/health', (req, res) => {
  res.json({ service: 'telemetry-service', status: 'UP', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[TELEMETRY-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});
