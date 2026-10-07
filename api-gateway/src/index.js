const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(morgan('dev'));

// Configuración de URLs de Microservicios (vía variables de entorno en Docker o localhost)
const IAM_SERVICE_URL = process.env.IAM_SERVICE_URL || 'http://localhost:3001';
const TELEMETRY_SERVICE_URL = process.env.TELEMETRY_SERVICE_URL || 'http://localhost:3002';
const CONTAINER_SERVICE_URL = process.env.CONTAINER_SERVICE_URL || 'http://localhost:3003';
const SECURITY_SERVICE_URL = process.env.SECURITY_SERVICE_URL || 'http://localhost:3004';
const ORDERS_SERVICE_URL = process.env.ORDERS_SERVICE_URL || 'http://localhost:3005';

// Rutas de salud y bienvenida
app.get('/', (req, res) => {
  res.json({
    name: 'Cold2Hot API Gateway',
    version: '1.0.0',
    status: 'HEALTHY',
    routes: {
      iam: '/api/v1/iam',
      telemetry: '/api/v1/telemetry',
      containers: '/api/v1/containers',
      security: '/api/v1/security',
      orders: '/api/v1/orders'
    }
  });
});

// Enrutamiento inverso hacia Microservicios
app.use('/api/v1/iam', createProxyMiddleware({ target: IAM_SERVICE_URL, changeOrigin: true }));
app.use('/api/v1/telemetry', createProxyMiddleware({ target: TELEMETRY_SERVICE_URL, changeOrigin: true }));
app.use('/api/v1/containers', createProxyMiddleware({ target: CONTAINER_SERVICE_URL, changeOrigin: true }));
app.use('/api/v1/security', createProxyMiddleware({ target: SECURITY_SERVICE_URL, changeOrigin: true }));
app.use('/api/v1/orders', createProxyMiddleware({ target: ORDERS_SERVICE_URL, changeOrigin: true }));

app.listen(PORT, () => {
  console.log(`[API-GATEWAY] Cold2Hot API Gateway escuchando en el puerto ${PORT}`);
});
