/**
 * Fotos de evidencia en Supabase Storage (API REST, sin SDK).
 * Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (o una secret key sb_secret_...).
 * El bucket es público para lectura: la web muestra la foto con su URL directa, y la ruta lleva un UUID
 * aleatorio para que no se pueda adivinar.
 */
const crypto = require('crypto');

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = process.env.EVIDENCE_BUCKET || 'delivery-evidence';
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const enabled = Boolean(BASE && KEY);

// Las claves nuevas (sb_secret_...) no son JWT: van solo en el header apikey
const headers = (extra = {}) => ({
  apikey: KEY,
  ...(KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}),
  ...extra
});

/** Decodifica "data:image/jpeg;base64,..." o Base64 pelado (se asume JPEG). */
function parseImage(input) {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(String(input).trim());
  const contentType = m ? m[1].toLowerCase() : 'image/jpeg';
  if (!TYPES[contentType]) return { error: 'Formato de imagen no soportado (usa JPEG, PNG o WebP)' };
  const buffer = Buffer.from(m ? m[2] : String(input), 'base64');
  if (!buffer.length) return { error: 'La imagen está vacía o no es Base64 válido' };
  if (buffer.length > MAX_BYTES) return { error: 'La imagen supera los 5 MB' };
  return { contentType, buffer };
}

/** Crea el bucket si no existe (idempotente). */
async function ensureBucket() {
  if (!enabled) return false;
  const res = await fetch(`${BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: MAX_BYTES, allowed_mime_types: Object.keys(TYPES) }),
    signal: AbortSignal.timeout(10000)
  });
  if (res.ok) return true;
  const body = await res.text();
  if (/already exists|Duplicate/i.test(body)) return true;
  throw new Error(`Storage ${res.status}: ${body.slice(0, 200)}`);
}

/** Sube la imagen y devuelve { storagePath, photoUrl, contentType, sizeBytes }. */
async function uploadEvidence(orderId, image) {
  const storagePath = `orders/${orderId}/${crypto.randomUUID()}.${TYPES[image.contentType]}`;
  const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': image.contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' }),
    body: image.buffer,
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Storage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return {
    storagePath,
    photoUrl: `${BASE}/storage/v1/object/public/${BUCKET}/${storagePath}`,
    contentType: image.contentType,
    sizeBytes: image.buffer.length
  };
}

/** Borra un objeto (best effort, para no dejar huérfanos si falla el guardado). */
async function removeEvidence(storagePath) {
  if (!enabled || !storagePath) return;
  await fetch(`${BASE}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [storagePath] }),
    signal: AbortSignal.timeout(10000)
  }).catch(() => {});
}

module.exports = { enabled, BUCKET, parseImage, ensureBucket, uploadEvidence, removeEvidence };
