/**
 * Utilidades de las pruebas de integración.
 * Levanta el orquestador completo (5 microservicios + API Gateway) en puertos libres,
 * con archivos de datos temporales y sin DATABASE_URL (persistencia local), de modo que
 * las pruebas son aisladas, repetibles y no tocan Supabase.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 300 } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastError = e;
    }
    await sleep(interval);
  }
  throw new Error(`Tiempo de espera agotado${lastError ? `: ${lastError.message}` : ''}`);
}

async function startBackend() {
  const [gateway, iam, telemetry, container, security, orders] = await Promise.all(Array.from({ length: 6 }, freePort));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold2hot-test-'));
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  Object.assign(env, {
    NODE_ENV: 'test',
    PORT: String(gateway),
    INTERNAL_IAM_PORT: String(iam),
    INTERNAL_TELEMETRY_PORT: String(telemetry),
    INTERNAL_CONTAINER_PORT: String(container),
    INTERNAL_SECURITY_PORT: String(security),
    INTERNAL_ORDERS_PORT: String(orders),
    IAM_DATA_FILE: path.join(dataDir, 'iam.json'),
    TELEMETRY_DATA_FILE: path.join(dataDir, 'telemetry.json'),
    CONTAINER_DATA_FILE: path.join(dataDir, 'container.json'),
    SECURITY_DATA_FILE: path.join(dataDir, 'security.json'),
    ORDERS_DATA_FILE: path.join(dataDir, 'orders.json'),
    JWT_SECRET: 'test-secret'
  });

  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = `http://127.0.0.1:${gateway}`;

  await waitFor(async () => (await fetch(`${base}/`)).ok);
  for (const svc of ['iam', 'telemetry', 'containers', 'security', 'orders']) {
    await waitFor(async () => (await fetch(`${base}/api/v1/${svc}/health`)).ok);
  }

  const api = async (method, route, { body, token } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* respuesta sin cuerpo */
    }
    return { status: res.status, data };
  };

  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { base, api, stop };
}

/** Sufijo único para evitar colisiones entre ejecuciones. */
const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** MAC válida y única. */
const randomMac = () =>
  Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();

module.exports = { startBackend, uid, randomMac };
