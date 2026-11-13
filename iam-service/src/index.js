const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'cold2hot-dev-secret-change-me';
const TOKEN_TTL_SEC = 8 * 60 * 60;
const DATA_FILE = process.env.IAM_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

app.use(cors());
app.use(express.json());

// ---------- Utilidades de seguridad (sin dependencias externas) ----------
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const signToken = (payload) => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
};

const verifyToken = (token) => {
  const [header, body, sig] = String(token || '').split('.');
  if (!header || !body || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
};

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
};

const checkPassword = (password, stored) => {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 32);
  const real = Buffer.from(hash, 'hex');
  return calc.length === real.length && crypto.timingSafeEqual(calc, real);
};

// ---------- Persistencia en archivo JSON ----------
const seed = () => ({
  restaurants: [{ restaurantId: 'REST-001', restaurantName: 'La Pergola Delivery' }],
  users: [
    {
      id: 'USR-001',
      email: 'admin@mirestaurante.pe',
      name: 'Diego R.',
      role: 'ADMINISTRATOR',
      restaurantId: 'REST-001',
      passwordHash: hashPassword('password123')
    }
  ],
  resetTokens: []
});

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return seed();
  }
};

let db = load();

const save = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn('[IAM-SERVICE] No se pudo persistir en disco:', e.message);
  }
};
save();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const restaurantOf = (user) => db.restaurants.find((r) => r.restaurantId === user.restaurantId);
const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  restaurantId: u.restaurantId,
  restaurantName: restaurantOf(u)?.restaurantName || ''
});

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const payload = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' });
  req.auth = payload;
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.auth.role !== 'ADMINISTRATOR') return res.status(403).json({ error: 'Se requiere rol de administrador' });
  next();
};

// ---------- OpenAPI ----------
const json = (properties) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties } } }
});
const bearer = [{ bearerAuth: [] }];
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - IAM Microservice API',
    version: '2.0.0',
    description: 'Autenticación con JWT, registro de restaurantes, operadores de entrega y recuperación de contraseña.'
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  paths: {
    '/auth/login': {
      post: {
        summary: 'Iniciar sesión',
        requestBody: json({ email: { type: 'string', example: 'admin@mirestaurante.pe' }, password: { type: 'string', example: 'password123' } }),
        responses: { 200: { description: 'JWT y datos de usuario' }, 400: { description: 'Datos faltantes' }, 401: { description: 'Credenciales inválidas' } }
      }
    },
    '/auth/register': {
      post: {
        summary: 'Registrar restaurante y administrador',
        requestBody: json({ restaurantName: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } }),
        responses: { 201: { description: 'Creado' }, 400: { description: 'Datos inválidos' }, 409: { description: 'Email ya registrado' } }
      }
    },
    '/auth/me': { get: { summary: 'Usuario autenticado', security: bearer, responses: { 200: { description: 'OK' }, 401: { description: 'No autorizado' } } } },
    '/auth/forgot-password': {
      post: { summary: 'Solicitar recuperación de contraseña', requestBody: json({ email: { type: 'string' } }), responses: { 202: { description: 'Aceptado' } } }
    },
    '/auth/reset-password': {
      post: { summary: 'Restablecer contraseña', requestBody: json({ token: { type: 'string' }, newPassword: { type: 'string' } }), responses: { 200: { description: 'OK' }, 400: { description: 'Token inválido' } } }
    },
    '/operators': {
      get: { summary: 'Listar operadores del restaurante', security: bearer, responses: { 200: { description: 'OK' } } },
      post: { summary: 'Crear operador', security: bearer, requestBody: json({ fullName: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } }), responses: { 201: { description: 'Creado' }, 409: { description: 'Email duplicado' } } }
    },
    '/operators/{id}': {
      delete: { summary: 'Eliminar operador', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Eliminado' }, 404: { description: 'No encontrado' } } }
    }
  }
};
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ---------- Endpoints ----------
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const user = db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user || !checkPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  const token = signToken({ sub: user.id, email: user.email, role: user.role, restaurantId: user.restaurantId });
  res.json({ message: 'Inicio de sesión exitoso', token, user: publicUser(user) });
});

app.post('/auth/register', (req, res) => {
  const { restaurantName, email, password } = req.body || {};
  const errors = {};
  if (!restaurantName || !String(restaurantName).trim()) errors.restaurantName = 'Nombre del restaurante requerido';
  if (!email || !EMAIL_RE.test(email)) errors.email = 'Email inválido';
  if (!password || String(password).length < 8) errors.password = 'La contraseña debe tener al menos 8 caracteres';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });
  if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'El email ya está registrado' });
  }

  const restaurantId = 'REST-' + String(db.restaurants.length + 1).padStart(3, '0');
  db.restaurants.push({ restaurantId, restaurantName: String(restaurantName).trim() });
  db.users.push({
    id: 'USR-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    email,
    name: email.split('@')[0],
    role: 'ADMINISTRATOR',
    restaurantId,
    passwordHash: hashPassword(password)
  });
  save();
  res.status(201).json({ message: 'Restaurante registrado satisfactoriamente', restaurantId, restaurantName: String(restaurantName).trim(), email });
});

app.get('/auth/me', requireAuth, (req, res) => {
  const user = db.users.find((u) => u.id === req.auth.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  res.json(publicUser(user));
});

app.post('/auth/forgot-password', (req, res) => {
  const { email } = req.body || {};
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  // Respuesta uniforme para no revelar qué correos existen. Sin servidor de correo, en desarrollo
  // se devuelve el token en la respuesta; en producción debería enviarse por email.
  const body = { message: 'Si el correo existe, se enviaron instrucciones para restablecer la contraseña' };
  if (user) {
    const token = crypto.randomBytes(16).toString('hex');
    db.resetTokens.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 });
    save();
    if (process.env.NODE_ENV !== 'production') body.devResetToken = token;
  }
  res.status(202).json(body);
});

app.post('/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  const entry = db.resetTokens.find((t) => t.token === token && t.expiresAt > Date.now());
  const user = entry && db.users.find((u) => u.id === entry.userId);
  if (!user) return res.status(400).json({ error: 'Token inválido o expirado' });
  user.passwordHash = hashPassword(newPassword);
  db.resetTokens = db.resetTokens.filter((t) => t.token !== token);
  save();
  res.json({ message: 'Contraseña actualizada' });
});

app.get('/operators', requireAuth, (req, res) => {
  res.json(db.users.filter((u) => u.role === 'OPERATOR' && u.restaurantId === req.auth.restaurantId).map(publicUser));
});

app.post('/operators', requireAuth, requireAdmin, (req, res) => {
  const { fullName, email, password } = req.body || {};
  const errors = {};
  if (!fullName || !String(fullName).trim()) errors.fullName = 'Nombre requerido';
  if (!email || !EMAIL_RE.test(email)) errors.email = 'Email inválido';
  if (!password || String(password).length < 8) errors.password = 'La contraseña debe tener al menos 8 caracteres';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });
  if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'El email ya está registrado' });
  }
  const user = {
    id: 'USR-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    email,
    name: String(fullName).trim(),
    role: 'OPERATOR',
    restaurantId: req.auth.restaurantId,
    passwordHash: hashPassword(password)
  };
  db.users.push(user);
  save();
  res.status(201).json(publicUser(user));
});

app.delete('/operators/:id', requireAuth, requireAdmin, (req, res) => {
  const idx = db.users.findIndex((u) => u.id === req.params.id && u.role === 'OPERATOR' && u.restaurantId === req.auth.restaurantId);
  if (idx === -1) return res.status(404).json({ error: 'Operador no encontrado' });
  db.users.splice(idx, 1);
  save();
  res.status(204).end();
});

app.get('/health', (req, res) => {
  res.json({ service: 'iam-service', status: 'UP', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[IAM-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});
