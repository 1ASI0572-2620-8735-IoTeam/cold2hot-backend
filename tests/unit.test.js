/**
 * Pruebas unitarias de las reglas de negocio puras del Security Service (OTP y detección de apertura).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOtp, classifyTamper, normId, maskCode, generateCode, newId } = require('../security-service/src/rules');

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

describe('evaluateOtp', () => {
  test('rechaza un código inexistente', () => {
    assert.equal(evaluateOtp(null), 'INVALID_CODE');
  });
  test('autoriza un OTP vigente', () => {
    assert.equal(evaluateOtp({ used: false, revoked: false, expiresAt: future() }), 'AUTHORIZED');
  });
  test('rechaza un OTP ya consumido', () => {
    assert.equal(evaluateOtp({ used: true, revoked: false, expiresAt: future() }), 'ALREADY_USED');
  });
  test('rechaza un OTP revocado', () => {
    assert.equal(evaluateOtp({ used: false, revoked: true, expiresAt: future() }), 'INVALID_CODE');
  });
  test('rechaza un OTP expirado', () => {
    assert.equal(evaluateOtp({ used: false, revoked: false, expiresAt: past() }), 'EXPIRED_CODE');
  });
});

describe('classifyTamper (seguridad de dos niveles)', () => {
  const locked = { lockState: 'LOCKED' };
  const unlocked = { lockState: 'UNLOCKED' };

  test('cierre de tapa: sin alerta y vuelve a bloquear', () => {
    assert.deepEqual(classifyTamper({ lock: unlocked, lidOpen: false }), { authorized: null, alert: null, relock: true });
  });
  test('apertura con cerrojo liberado por OTP: autorizada, sin alerta', () => {
    const r = classifyTamper({ lock: unlocked, lidOpen: true, packagePresent: true, forced: false });
    assert.equal(r.authorized, true);
    assert.equal(r.alert, null);
  });
  test('tapa abierta sin OTP con paquete presente: aviso preventivo (WARNING)', () => {
    const r = classifyTamper({ lock: locked, lidOpen: true, packagePresent: true, forced: false });
    assert.equal(r.authorized, false);
    assert.equal(r.alert.type, 'LID_OPEN');
    assert.equal(r.alert.severity, 'WARNING');
  });
  test('tapa abierta sin OTP y paquete ausente: acceso no autorizado (CRITICAL)', () => {
    const r = classifyTamper({ lock: locked, lidOpen: true, packagePresent: false, forced: false });
    assert.equal(r.alert.type, 'UNAUTHORIZED_ACCESS');
    assert.equal(r.alert.severity, 'CRITICAL');
  });
  test('apertura forzada: siempre CRITICAL, incluso con el cerrojo liberado', () => {
    const r = classifyTamper({ lock: unlocked, lidOpen: true, packagePresent: true, forced: true });
    assert.equal(r.authorized, false);
    assert.equal(r.alert.severity, 'CRITICAL');
  });
});

describe('utilidades', () => {
  test('generateCode devuelve 6 dígitos', () => {
    for (let i = 0; i < 50; i++) assert.match(generateCode(), /^\d{6}$/);
  });
  test('maskCode oculta todo salvo los 2 últimos dígitos', () => {
    assert.equal(maskCode('123456'), '****56');
    assert.equal(maskCode(null), null);
  });
  test('normId quita el prefijo # de los pedidos', () => {
    assert.equal(normId('#C2H-10482'), 'C2H-10482');
    assert.equal(normId('C2H-10482'), 'C2H-10482');
    assert.equal(normId(null), null);
  });
  test('newId usa el prefijo indicado', () => {
    assert.match(newId('OTP'), /^OTP-\d+-\d{4}$/);
  });
});
