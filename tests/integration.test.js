/**
 * Pruebas de integración de extremo a extremo a través del API Gateway.
 * Cubren las historias de usuario del Sprint 2: US03, US04, US05, US07, US09, US10, US11, US12, US13, US14, US16, US17, US20.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startBackend, uid, randomMac } = require('./helpers');

let backend;
let api;

before(async () => {
  backend = await startBackend();
  api = backend.api;
});

after(async () => {
  await backend.stop();
});

describe('API Gateway', () => {
  test('GET / expone el catálogo de rutas y el estado HEALTHY', async () => {
    const { status, data } = await api('GET', '/');
    assert.equal(status, 200);
    assert.equal(data.status, 'HEALTHY');
    assert.deepEqual(Object.keys(data.routes).sort(), ['containers', 'iam', 'orders', 'security', 'telemetry']);
  });

  test('cada microservicio responde su healthcheck a través del Gateway', async () => {
    for (const svc of ['iam', 'telemetry', 'containers', 'security', 'orders']) {
      const { status, data } = await api('GET', `/api/v1/${svc}/health`);
      assert.equal(status, 200, svc);
      assert.equal(data.status, 'UP', svc);
    }
  });
});

describe('IAM: registro, sesión, operadores y recuperación (US10, US11, US12, US20)', () => {
  const email = `admin-${uid()}@test.pe`;
  const password = 'Clave-segura-1';
  let token;

  test('US10: el registro valida los datos de entrada', async () => {
    const { status, data } = await api('POST', '/api/v1/iam/auth/register', { body: { admin: { name: '', email: 'no-es-email', password: '123' }, restaurant: {} } });
    assert.equal(status, 400);
    assert.ok(data.details['admin.email']);
    assert.ok(data.details['admin.password']);
    assert.ok(data.details['restaurant.name']);
  });

  test('US10: registra restaurante y administrador y devuelve una sesión con JWT', async () => {
    const { status, data } = await api('POST', '/api/v1/iam/auth/register', {
      body: { admin: { name: 'Admin Test', email, password }, restaurant: { name: 'Restaurante de Prueba' } }
    });
    assert.equal(status, 201);
    assert.ok(data.token);
    assert.equal(data.user.email, email);
    assert.equal(data.user.role, 'ADMINISTRATOR');
  });

  test('US10: rechaza un correo ya registrado', async () => {
    const { status } = await api('POST', '/api/v1/iam/auth/register', {
      body: { admin: { name: 'Otro', email, password }, restaurant: { name: 'Otro' } }
    });
    assert.equal(status, 409);
  });

  test('US11: inicia sesión con credenciales válidas', async () => {
    const { status, data } = await api('POST', '/api/v1/iam/auth/login', { body: { email, password } });
    assert.equal(status, 200);
    assert.ok(data.token);
    token = data.token;
  });

  test('US11: rechaza una contraseña incorrecta y un cuerpo incompleto', async () => {
    assert.equal((await api('POST', '/api/v1/iam/auth/login', { body: { email, password: 'incorrecta' } })).status, 401);
    assert.equal((await api('POST', '/api/v1/iam/auth/login', { body: { email } })).status, 400);
  });

  test('US11: los endpoints protegidos exigen un token válido', async () => {
    assert.equal((await api('GET', '/api/v1/iam/users/me')).status, 401);
    assert.equal((await api('GET', '/api/v1/iam/users/me', { token: 'token-falso' })).status, 401);
    const { status, data } = await api('GET', '/api/v1/iam/users/me', { token });
    assert.equal(status, 200);
    assert.equal(data.user.email, email);
    assert.equal(data.restaurant.name, 'Restaurante de Prueba');
  });

  test('US12: invita, lista y evita duplicados de operadores', async () => {
    const opEmail = `op-${uid()}@test.pe`;
    const created = await api('POST', '/api/v1/iam/operators', { token, body: { name: 'Operador Uno', email: opEmail } });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, 'INVITED');

    assert.equal((await api('POST', '/api/v1/iam/operators', { token, body: { name: 'Operador Uno', email: opEmail } })).status, 409);
    assert.equal((await api('POST', '/api/v1/iam/operators', { token, body: { name: '', email: 'x' } })).status, 400);

    const list = await api('GET', '/api/v1/iam/operators', { token });
    assert.equal(list.status, 200);
    assert.ok(list.data.some((o) => o.email === opEmail));

    const patched = await api('PATCH', `/api/v1/iam/operators/${created.data.operatorId}/status`, { token, body: { status: 'INACTIVE' } });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.status, 'INACTIVE');
    assert.equal((await api('PATCH', `/api/v1/iam/operators/${created.data.operatorId}/status`, { token, body: { status: 'OTRO' } })).status, 400);
    assert.equal((await api('PATCH', '/api/v1/iam/operators/NO-EXISTE/status', { token, body: { status: 'ACTIVE' } })).status, 404);
  });

  test('US20: recupera la contraseña con un token temporal', async () => {
    const forgot = await api('POST', '/api/v1/iam/auth/forgot-password', { body: { email } });
    assert.equal(forgot.status, 200);
    assert.ok(forgot.data.devResetToken, 'fuera de producción se devuelve el token para pruebas');

    const weak = await api('POST', '/api/v1/iam/auth/reset-password', { body: { token: forgot.data.devResetToken, newPassword: '123' } });
    assert.equal(weak.status, 400);

    const reset = await api('POST', '/api/v1/iam/auth/reset-password', { body: { token: forgot.data.devResetToken, newPassword: 'Nueva-clave-2' } });
    assert.equal(reset.status, 200);

    assert.equal((await api('POST', '/api/v1/iam/auth/login', { body: { email, password } })).status, 401);
    assert.equal((await api('POST', '/api/v1/iam/auth/login', { body: { email, password: 'Nueva-clave-2' } })).status, 200);
  });

  test('US20: no revela si un correo existe y rechaza tokens inválidos', async () => {
    const unknown = await api('POST', '/api/v1/iam/auth/forgot-password', { body: { email: `nadie-${uid()}@test.pe` } });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.data.devResetToken, undefined);
    assert.equal((await api('POST', '/api/v1/iam/auth/reset-password', { body: { token: 'inexistente', newPassword: 'Nueva-clave-2' } })).status, 400);
  });

  test('catálogo de planes de suscripción es público', async () => {
    const { status, data } = await api('GET', '/api/v1/iam/subscriptions/plans');
    assert.equal(status, 200);
    const plans = Array.isArray(data) ? data : data.plans;
    assert.ok(Array.isArray(plans) && plans.length >= 1, 'debe listar al menos un plan');
  });
});

describe('Container Service: inventario y batería (US13, US14)', () => {
  test('US13: valida el formato de MAC y el peso máximo', async () => {
    const { status, data } = await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: '', macAddress: 'zz', maxWeightKg: -1 } });
    assert.equal(status, 400);
    assert.ok(data.details.macAddress);
    assert.ok(data.details.maxWeightKg);
  });

  test('US13: registra una SmartBox y rechaza serie o MAC duplicadas', async () => {
    const mac = randomMac();
    const serial = `SN-${uid()}`;
    const created = await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: serial, macAddress: mac, maxWeightKg: 12 } });
    assert.equal(created.status, 201);
    assert.ok(created.data.boxId);

    assert.equal((await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: serial, macAddress: randomMac(), maxWeightKg: 12 } })).status, 409);
    assert.equal((await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: `SN-${uid()}`, macAddress: mac, maxWeightKg: 12 } })).status, 409);

    const detail = await api('GET', `/api/v1/containers/smartboxes/${created.data.boxId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.macAddress, mac);
    assert.equal((await api('GET', '/api/v1/containers/smartboxes/NO-EXISTE')).status, 404);
  });

  test('US13: el emparejamiento exige deviceId y no permite reutilizar el dispositivo', async () => {
    const a = await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: `SN-${uid()}`, macAddress: randomMac(), maxWeightKg: 10 } });
    const b = await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: `SN-${uid()}`, macAddress: randomMac(), maxWeightKg: 10 } });
    const deviceId = `ESP32-${uid()}`;
    assert.equal((await api('POST', `/api/v1/containers/smartboxes/${a.data.boxId}/pair-device`, { body: {} })).status, 400);
    assert.equal((await api('POST', `/api/v1/containers/smartboxes/${a.data.boxId}/pair-device`, { body: { deviceId } })).status, 200);
    assert.equal((await api('POST', `/api/v1/containers/smartboxes/${b.data.boxId}/pair-device`, { body: { deviceId } })).status, 409);
  });

  test('US14: un latido con batería baja genera una alerta LOW_BATTERY', async () => {
    const box = await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: `SN-${uid()}`, macAddress: randomMac(), maxWeightKg: 10 } });
    assert.equal((await api('POST', '/api/v1/containers/devices/heartbeat', { body: { boxId: box.data.boxId, batteryLevel: 150 } })).status, 400);
    assert.equal((await api('POST', '/api/v1/containers/devices/heartbeat', { body: { batteryLevel: 50 } })).status, 400);
    assert.equal((await api('POST', '/api/v1/containers/devices/heartbeat', { body: { boxId: 'NO-EXISTE', batteryLevel: 50 } })).status, 404);

    const beat = await api('POST', '/api/v1/containers/devices/heartbeat', { body: { boxId: box.data.boxId, batteryLevel: 9 } });
    assert.equal(beat.status, 200);

    const alerts = await api('GET', '/api/v1/containers/alerts');
    assert.equal(alerts.status, 200);
    const mine = alerts.data.filter((a) => a.boxId === box.data.boxId || a.smartBoxId === box.data.boxId);
    assert.ok(mine.length >= 1, 'debe existir una alerta de batería para la caja');

    const available = await api('GET', '/api/v1/containers/smartboxes/available');
    assert.ok(!available.data.some((b) => b.boxId === box.data.boxId), 'una caja con batería < 15% no está disponible para despacho');
  });

  test('el cambio de estado rechaza valores inválidos', async () => {
    const box = await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: `SN-${uid()}`, macAddress: randomMac(), maxWeightKg: 10 } });
    assert.equal((await api('PATCH', `/api/v1/containers/smartboxes/${box.data.boxId}/status`, { body: { status: 'VOLANDO' } })).status, 400);
    assert.equal((await api('PATCH', `/api/v1/containers/smartboxes/${box.data.boxId}/status`, { body: { status: 'MAINTENANCE' } })).status, 200);
  });
});

describe('Flujo de entrega: envío, OTP, telemetría, alertas y auditoría (US03, US04, US05, US07, US09, US16, US17)', () => {
  let boxId;
  let orderId;
  let otp;

  before(async () => {
    const box = await api('POST', '/api/v1/containers/smartboxes', { body: { serialNumber: `SN-${uid()}`, macAddress: randomMac(), maxWeightKg: 15 } });
    boxId = box.data.boxId;
    // Una caja nueva debe estar lista para despacho (batería suficiente)
    await api('POST', '/api/v1/containers/devices/heartbeat', { body: { boxId, batteryLevel: 90 } });
  });

  test('US03: valida los datos del envío', async () => {
    const { status, data } = await api('POST', '/api/v1/orders', { body: { customerName: 'Ana' } });
    assert.equal(status, 400);
    assert.ok(data.details.deliveryAddress);
    assert.ok(data.details.smartBoxId);
    assert.ok(data.details.thermalProfile);
  });

  test('US03: rechaza un rango térmico inválido y una caja inexistente', async () => {
    const base = { customerName: 'Ana', deliveryAddress: 'Av. Prueba 123', operatorId: 'OP-1' };
    assert.equal((await api('POST', '/api/v1/orders', { body: { ...base, smartBoxId: boxId, thermalProfile: { type: 'HOT', minTemperature: 80, maxTemperature: 60 } } })).status, 400);
    assert.equal((await api('POST', '/api/v1/orders', { body: { ...base, smartBoxId: 'NO-EXISTE', thermalProfile: { type: 'HOT' } } })).status, 404);
  });

  test('US03: crea un envío caliente, asigna la caja y emite un OTP de 6 dígitos', async () => {
    const { status, data } = await api('POST', '/api/v1/orders', {
      body: {
        customerName: 'Ana Prueba',
        deliveryAddress: 'Av. Prueba 123, Miraflores',
        smartBoxId: boxId,
        operatorId: 'OP-1',
        operatorName: 'Operador Uno',
        thermalProfile: { type: 'HOT', minTemperature: 55, maxTemperature: 75 }
      }
    });
    assert.equal(status, 201);
    assert.equal(data.status, 'IN_TRANSIT');
    assert.match(data.otp.code, /^\d{6}$/);
    assert.deepEqual(data.warnings, []);
    orderId = String(data.orderId).replace(/^#/, '');
    otp = data.otp.code;

    const box = await api('GET', `/api/v1/containers/smartboxes/${boxId}`);
    assert.equal(box.data.status, 'IN_TRANSIT');
  });

  test('US03: no permite un segundo envío con la misma caja', async () => {
    const { status } = await api('POST', '/api/v1/orders', {
      body: { customerName: 'Otro', deliveryAddress: 'Calle 1', smartBoxId: boxId, operatorId: 'OP-1', thermalProfile: { type: 'COLD' } }
    });
    assert.equal(status, 409);
  });

  test('US04: el envío figura entre los envíos activos y tiene detalle', async () => {
    const active = await api('GET', '/api/v1/orders/active');
    assert.equal(active.status, 200);
    assert.ok(active.data.some((o) => String(o.orderId).replace(/^#/, '') === orderId));

    const detail = await api('GET', `/api/v1/orders/${orderId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.smartBoxId, boxId);
    assert.equal(detail.data.thermalProfile.type, 'HOT');
  });

  test('US09 y US04: la ingesta registra lecturas dentro de rango y las expone por caja', async () => {
    const ingest = await api('POST', '/api/v1/telemetry/ingest', { body: { smartBoxId: boxId, shipmentId: orderId, temperature: 66.5, lidOpen: false } });
    assert.equal(ingest.status, 201);
    assert.equal(ingest.data.evaluation.status, 'IN_RANGE');
    assert.equal(ingest.data.alert, null);

    const current = await api('GET', `/api/v1/telemetry/boxes/${boxId}/current`);
    assert.equal(current.status, 200);
    assert.equal(current.data.temperature, 66.5);
    assert.equal(current.data.activeProfile.type, 'HOT');

    const history = await api('GET', `/api/v1/telemetry/boxes/${boxId}/history?limit=10`);
    assert.equal(history.status, 200);
    assert.ok(history.data.total >= 1);
  });

  test('US09: la ingesta valida los datos y no expone cajas sin lecturas', async () => {
    assert.equal((await api('POST', '/api/v1/telemetry/ingest', { body: { smartBoxId: boxId } })).status, 400);
    assert.equal((await api('POST', '/api/v1/telemetry/ingest', { body: { smartBoxId: boxId, temperature: 'caliente' } })).status, 400);
    assert.equal((await api('GET', '/api/v1/telemetry/boxes/SIN-LECTURAS/current')).status, 404);
  });

  test('US16: una lectura fuera de rango genera una alerta crítica única y se puede resolver', async () => {
    const first = await api('POST', '/api/v1/telemetry/ingest', { body: { smartBoxId: boxId, shipmentId: orderId, temperature: 42.1, lidOpen: false } });
    assert.equal(first.status, 201);
    assert.equal(first.data.evaluation.status, 'THERMAL_BREACH');
    assert.equal(first.data.alert.type, 'THERMAL_BREACH');
    assert.equal(first.data.alert.severity, 'CRITICAL');

    const second = await api('POST', '/api/v1/telemetry/ingest', { body: { smartBoxId: boxId, shipmentId: orderId, temperature: 40.3, lidOpen: false } });
    assert.equal(second.data.alert.alertId, first.data.alert.alertId, 'se mantiene una sola alerta abierta por envío');

    const open = await api('GET', `/api/v1/telemetry/alerts?resolved=false&orderId=${orderId}`);
    assert.equal(open.data.length, 1);

    const resolved = await api('PATCH', `/api/v1/telemetry/alerts/${first.data.alert.alertId}/resolve`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.resolved, true);
    assert.equal((await api('PATCH', '/api/v1/telemetry/alerts/NO-EXISTE/resolve')).status, 404);
  });

  test('US17: una apertura sin OTP y con paquete ausente genera una alerta CRITICAL', async () => {
    assert.equal((await api('POST', '/api/v1/security/tamper-events', { body: { smartBoxId: boxId } })).status, 400);

    const warning = await api('POST', '/api/v1/security/tamper-events', { body: { smartBoxId: boxId, orderId, lidOpen: true, packagePresent: true } });
    assert.equal(warning.status, 201);

    const critical = await api('POST', '/api/v1/security/tamper-events', { body: { smartBoxId: boxId, orderId, lidOpen: true, packagePresent: false } });
    assert.equal(critical.status, 201);

    const alerts = await api('GET', `/api/v1/security/alerts?orderId=${orderId}`);
    assert.equal(alerts.status, 200);
    const types = alerts.data.map((a) => a.type);
    assert.ok(types.includes('LID_OPEN'));
    assert.ok(types.includes('UNAUTHORIZED_ACCESS'));
    assert.equal(alerts.data[0].severity, 'CRITICAL', 'las alertas se ordenan por severidad');
  });

  test('US07: valida el OTP sin consumirlo y rechaza códigos incorrectos', async () => {
    const wrong = otp === '000000' ? '111111' : '000000';
    const bad = await api('POST', '/api/v1/security/otp/validate', { body: { orderId, smartBoxId: boxId, code: wrong } });
    assert.equal(bad.status, 200);
    assert.equal(bad.data.result, 'INVALID_CODE');

    const good = await api('POST', '/api/v1/security/otp/validate', { body: { orderId, smartBoxId: boxId, code: otp } });
    assert.equal(good.data.result, 'AUTHORIZED');

    const lock = await api('GET', `/api/v1/security/locks/${boxId}`);
    assert.equal(lock.data.lockState, 'LOCKED', 'validar no desbloquea');
  });

  test('US07: el desbloqueo exige un OTP válido y es de un solo uso', async () => {
    const wrong = otp === '000000' ? '111111' : '000000';
    const denied = await api('POST', '/api/v1/security/unlock', { body: { orderId, smartBoxId: boxId, code: wrong } });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.result, 'INVALID_CODE');
    assert.equal((await api('POST', '/api/v1/security/unlock', { body: { smartBoxId: boxId } })).status, 400);

    const ok = await api('POST', '/api/v1/security/unlock', { body: { orderId, smartBoxId: boxId, code: otp } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.result, 'AUTHORIZED');
    assert.equal(ok.data.lockState, 'UNLOCKED');

    const reuse = await api('POST', '/api/v1/security/unlock', { body: { orderId, smartBoxId: boxId, code: otp } });
    assert.equal(reuse.status, 403);
    assert.equal(reuse.data.result, 'ALREADY_USED');

    const attempts = await api('GET', `/api/v1/security/access-attempts?orderId=${orderId}`);
    assert.equal(attempts.status, 200);
    assert.ok(attempts.data.length >= 3, 'cada intento queda en la bitácora de accesos');
  });

  test('US07: una nueva emisión revoca el OTP anterior del mismo envío', async () => {
    const o = `TEST-${uid()}`;
    const first = await api('POST', '/api/v1/security/otp', { body: { orderId: o, smartBoxId: 'SB-X' } });
    const second = await api('POST', '/api/v1/security/otp', { body: { orderId: o, smartBoxId: 'SB-X' } });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    if (first.data.code !== second.data.code) {
      const old = await api('POST', '/api/v1/security/otp/validate', { body: { orderId: o, smartBoxId: 'SB-X', code: first.data.code } });
      assert.notEqual(old.data.result, 'AUTHORIZED');
    }
    assert.equal((await api('POST', '/api/v1/security/otp', { body: { orderId: o } })).status, 400);
  });

  test('US05: consolida y consulta el reporte de auditoría del envío', async () => {
    const preview = await api('GET', `/api/v1/orders/audits/${orderId}`);
    assert.equal(preview.status, 200);

    const consolidated = await api('POST', `/api/v1/orders/audits/${orderId}`);
    assert.ok([200, 201].includes(consolidated.status), `estado inesperado ${consolidated.status}`);

    const again = await api('GET', `/api/v1/orders/audits/${orderId}`);
    assert.equal(again.status, 200);
  });

  test('US05: el historial de envíos admite filtros y valida fechas', async () => {
    const all = await api('GET', '/api/v1/orders');
    assert.equal(all.status, 200);
    assert.ok(all.data.some((o) => String(o.orderId).replace(/^#/, '') === orderId));
    assert.equal((await api('GET', '/api/v1/orders?from=ayer')).status, 400);
  });
});
