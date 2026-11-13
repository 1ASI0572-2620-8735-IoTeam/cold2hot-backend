/**
 * Reglas de negocio puras de seguridad, compartidas por los dos repositorios.
 */
const crypto = require('crypto');

const newId = (prefix) => `${prefix}-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const maskCode = (code) => (code ? '****' + String(code).slice(-2) : null);
const normId = (id) => (id ? String(id).replace(/^#/, '') : null);

/** Resultado de un OTP candidato (el último emitido para esa caja/envío con ese código). */
const evaluateOtp = (otp) => {
  if (!otp) return 'INVALID_CODE';
  if (otp.used) return 'ALREADY_USED';
  if (otp.revoked) return 'INVALID_CODE';
  if (new Date(otp.expiresAt) < new Date()) return 'EXPIRED_CODE';
  return 'AUTHORIZED';
};

/**
 * Lógica de 2 niveles para un evento de tapa.
 * Devuelve si la apertura está autorizada, la alerta a crear (o null) y si hay que volver a bloquear.
 */
const classifyTamper = ({ lock, lidOpen, packagePresent, forced }) => {
  const authorized = lock.lockState === 'UNLOCKED' && !forced;
  if (!lidOpen) return { authorized: null, alert: null, relock: true };
  if (authorized) return { authorized: true, alert: null, relock: false };
  if (forced || packagePresent === false) {
    return {
      authorized: false,
      relock: false,
      alert: { type: 'UNAUTHORIZED_ACCESS', severity: 'CRITICAL', message: forced ? 'Apertura forzada detectada' : 'Tapa abierta sin OTP válido y paquete ausente' }
    };
  }
  return {
    authorized: false,
    relock: false,
    alert: { type: 'LID_OPEN', severity: 'WARNING', message: 'Tapa abierta sin OTP válido con paquete presente (aviso preventivo)' }
  };
};

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 };

module.exports = { newId, generateCode, maskCode, normId, evaluateOtp, classifyTamper, SEVERITY_ORDER };
