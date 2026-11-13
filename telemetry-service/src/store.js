/**
 * Conexión opcional a PostgreSQL (Supabase).
 * Con DATABASE_URL el servicio trabaja sobre sus tablas relacionales (definidas en src/schema.sql);
 * sin ella usa su archivo JSON local, pensado solo para desarrollo.
 *
 * DATABASE_SCHEMA permite usar otro esquema del mismo proyecto (p. ej. pruebas); por defecto `public`.
 */
const fs = require('fs');
const path = require('path');

let pool = null;
const SCHEMA = process.env.DATABASE_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error('DATABASE_SCHEMA inválido');

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX) || 2,
    ...(SCHEMA !== 'public' ? { options: `-c search_path=${SCHEMA},public` } : {})
  });
  pool.on('error', (e) => console.warn('[PG] conexión inactiva falló:', e.message));
}

/** Aplica el DDL idempotente del servicio (create ... if not exists). */
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  if (SCHEMA !== 'public') await pool.query(`create schema if not exists ${SCHEMA}`);
  await pool.query(sql);
}

/**
 * Documento JSONB que el servicio guardaba en public.service_state antes de pasar a tablas.
 * Se usa una sola vez, para importar los datos cuando las tablas están vacías.
 */
async function legacyState(service) {
  try {
    const { rows } = await pool.query('select data from public.service_state where service = $1', [service]);
    return rows[0] ? rows[0].data : null;
  } catch {
    return null;
  }
}

/** Ejecuta fn(client) dentro de una transacción. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, legacyState, tx };
