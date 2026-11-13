/**
 * Persistencia opcional en PostgreSQL (Supabase).
 * Si DATABASE_URL está definida, el estado del servicio se guarda como un documento JSONB en la tabla
 * public.service_state y sobrevive a los redeploys. Sin DATABASE_URL no hace nada y el servicio sigue
 * usando su archivo JSON local.
 */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 2
  });
  pool.on('error', (e) => console.warn('[PG] conexión inactiva falló:', e.message));
}

/**
 * @param {string} name  clave del servicio (fila de service_state)
 * @param {() => object} get  devuelve el estado actual en memoria
 * @param {(doc: object) => void} set  reemplaza el estado en memoria
 */
function attach(name, get, set) {
  if (!pool) return { push() {} };
  let ready = false;
  let timer = null;
  let dirty = false;

  const flush = async () => {
    timer = null;
    if (!ready || !dirty) return;
    dirty = false;
    try {
      await pool.query(
        'insert into public.service_state (service, data, updated_at) values ($1, $2, now()) ' +
          'on conflict (service) do update set data = excluded.data, updated_at = now()',
        [name, JSON.stringify(get())]
      );
    } catch (e) {
      dirty = true;
      console.warn(`[PG] no se pudo guardar ${name}:`, e.message);
    }
  };

  // Carga inicial: si ya hay un documento en la base, manda sobre el seed local.
  (async () => {
    try {
      const r = await pool.query('select data from public.service_state where service = $1', [name]);
      if (r.rows.length) set(r.rows[0].data);
      else dirty = true;
      console.log(`[PG] ${name}: ${r.rows.length ? 'estado cargado desde la base' : 'sin estado previo, se guardará el inicial'}`);
    } catch (e) {
      console.warn(`[PG] no se pudo cargar ${name}; se sigue con el archivo local:`, e.message);
      return;
    }
    ready = true;
    flush();
  })();

  return {
    push() {
      dirty = true;
      if (!timer) timer = setTimeout(flush, 1000);
    }
  };
}

module.exports = { attach };
