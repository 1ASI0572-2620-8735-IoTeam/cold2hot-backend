/**
 * Cold2Hot - Backend Microservices Cloud Orchestrator
 * Inicia los microservicios independientes en puertos internos y expone el API Gateway como punto de entrada perimetral.
 * Compatible con despliegues de contenedor único (Render, Railway, Fly.io) y multi-contenedor (Docker Compose).
 */
const { fork } = require('child_process');
const path = require('path');

const IAM_PORT = process.env.INTERNAL_IAM_PORT || 3001;
const TELEMETRY_PORT = process.env.INTERNAL_TELEMETRY_PORT || 3002;
const CONTAINER_PORT = process.env.INTERNAL_CONTAINER_PORT || 3003;
const SECURITY_PORT = process.env.INTERNAL_SECURITY_PORT || 3004;
const ORDERS_PORT = process.env.INTERNAL_ORDERS_PORT || 3005;
const GATEWAY_PORT = process.env.PORT || 8080;

const urls = {
  IAM_SERVICE_URL: `http://127.0.0.1:${IAM_PORT}`,
  TELEMETRY_SERVICE_URL: `http://127.0.0.1:${TELEMETRY_PORT}`,
  CONTAINER_SERVICE_URL: `http://127.0.0.1:${CONTAINER_PORT}`,
  SECURITY_SERVICE_URL: `http://127.0.0.1:${SECURITY_PORT}`,
  ORDERS_SERVICE_URL: `http://127.0.0.1:${ORDERS_PORT}`
};

console.log('====================================================');
console.log('   Cold2Hot IoT - Cloud Microservices Orchestrator  ');
console.log('====================================================');

const services = [
  ['iam-service', IAM_PORT],
  ['telemetry-service', TELEMETRY_PORT],
  ['container-service', CONTAINER_PORT],
  ['security-service', SECURITY_PORT],
  ['orders-service', ORDERS_PORT]
];

const children = services.map(([name, port]) =>
  fork(path.join(__dirname, name, 'src', 'index.js'), [], {
    env: { ...process.env, ...urls, PORT: port }
  })
);

// API Gateway perimetral tras inicialización de servicios
setTimeout(() => {
  const gateway = fork(path.join(__dirname, 'api-gateway', 'src', 'index.js'), [], {
    env: { ...process.env, ...urls, PORT: GATEWAY_PORT }
  });
  children.push(gateway);
}, 800);

const cleanup = () => {
  console.log('[ORCHESTRATOR] Deteniendo microservicios...');
  children.forEach((c) => {
    try { c.kill(); } catch (e) {}
  });
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
