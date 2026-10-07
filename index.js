/**
 * Cold2Hot - Backend Microservices Cloud Orchestrator
 * Inicia los microservicios independientes en puertos internos y expone el API Gateway como punto de entrada perimetral.
 * Compatible con despliegues de contenedor único (Render, Railway, Fly.io) y multi-contenedor (Docker Compose).
 */
const { fork } = require('child_process');
const path = require('path');

const IAM_PORT = process.env.INTERNAL_IAM_PORT || 3001;
const TELEMETRY_PORT = process.env.INTERNAL_TELEMETRY_PORT || 3002;
const GATEWAY_PORT = process.env.PORT || 8080;

console.log('====================================================');
console.log('   Cold2Hot IoT - Cloud Microservices Orchestrator  ');
console.log('====================================================');

// 1. Iniciar Microservicio IAM (Identidad y Accesos)
const iamProcess = fork(path.join(__dirname, 'iam-service', 'src', 'index.js'), [], {
  env: { ...process.env, PORT: IAM_PORT }
});

// 2. Iniciar Microservicio de Telemetría Térmica
const telemetryProcess = fork(path.join(__dirname, 'telemetry-service', 'src', 'index.js'), [], {
  env: { ...process.env, PORT: TELEMETRY_PORT }
});

// 3. Iniciar API Gateway perimetral tras inicialización de servicios
setTimeout(() => {
  const gatewayProcess = fork(path.join(__dirname, 'api-gateway', 'src', 'index.js'), [], {
    env: {
      ...process.env,
      PORT: GATEWAY_PORT,
      IAM_SERVICE_URL: `http://127.0.0.1:${IAM_PORT}`,
      TELEMETRY_SERVICE_URL: `http://127.0.0.1:${TELEMETRY_PORT}`
    }
  });

  const cleanup = () => {
    console.log('[ORCHESTRATOR] Deteniendo microservicios...');
    try { iamProcess.kill(); } catch (e) {}
    try { telemetryProcess.kill(); } catch (e) {}
    try { gatewayProcess.kill(); } catch (e) {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}, 800);
