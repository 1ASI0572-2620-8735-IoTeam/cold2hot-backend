const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const CONTAINER_URL = process.env.CONTAINER_SERVICE_URL || 'http://localhost:3003';
const JWT_SECRET = process.env.JWT_SECRET || 'cold2hot-dev-secret-change-me';
const TOKEN_TTL_HOURS = 8;
const RESET_TTL_MIN = 30;

// Planes (alinear precios con la Landing Page). maxBoxes null = ilimitado
const PLANS = {
  STARTER: { plan: 'STARTER', name: 'Starter', monthlyPrice: 149, currency: 'PEN', maxBoxes: 5, maxOperators: 5, highlighted: false },
  PRO: { plan: 'PRO', name: 'Pro', monthlyPrice: 349, currency: 'PEN', maxBoxes: 20, maxOperators: 25, highlighted: true },
  ENTERPRISE: { plan: 'ENTERPRISE', name: 'Enterprise', monthlyPrice: 899, currency: 'PEN', maxBoxes: null, maxOperators: null, highlighted: false }
};

// Utilidades de seguridad
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;

const verifyPassword = (password, stored) => {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');

const createToken = (user) => {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    sub: user.userId,
    email: user.email,
    role: user.role,
    restaurantId: user.restaurantId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_HOURS * 3600
  });
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
};

const verifyToken = (token) => {
  const [header, payload, signature] = (token || '').split('.');
  if (!header || !payload || !signature) return null;
  const expected = sign(`${header}.${payload}`);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${crypto.randomInt(100000, 999999)}`;

const DATA_FILE = process.env.IAM_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

const seed = () => ({
  restaurants: [
    {
      restaurantId: 'REST-001',
      name: 'La Pergola Delivery',
      ruc: '20601234567',
      phone: '+51 987 654 321',
      address: 'Av. Larco 1150, Miraflores',
      settings: {
        defaultThresholds: { COLD: { minTemperature: 0, maxTemperature: 8 }, HOT: { minTemperature: 55, maxTemperature: 75 } },
        notifications: { email: true, push: true, criticalOnly: false }
      },
      subscription: { plan: 'PRO', status: 'ACTIVE', paymentMethod: { brand: 'VISA', last4: '4242' }, startedAt: now(), renewsAt: new Date(Date.now() + 30 * 86400000).toISOString() },
      createdAt: now()
    }
  ],
  users: [
    { userId: 'USR-001', email: 'admin@mirestaurante.pe', passwordHash: hashPassword('password123'), name: 'Diego R.', role: 'ADMINISTRATOR', restaurantId: 'REST-001', createdAt: now() }
  ],
  operators: [
    { operatorId: 'OP-001', restaurantId: 'REST-001', name: 'Carlos Ruiz', email: 'carlos.ruiz@mirestaurante.pe', phone: '+51 911 111 111', status: 'ACTIVE', completedDeliveries: 124, custodyRating: 4.9, invitedAt: now() },
    { operatorId: 'OP-002', restaurantId: 'REST-001', name: 'Lucía Torres', email: 'lucia.torres@mirestaurante.pe', phone: '+51 922 222 222', status: 'ACTIVE', completedDeliveries: 98, custodyRating: 4.6, invitedAt: now() },
    { operatorId: 'OP-003', restaurantId: 'REST-001', name: 'Diego Ramos', email: 'diego.ramos@mirestaurante.pe', phone: '+51 933 333 333', status: 'ACTIVE', completedDeliveries: 76, custodyRating: 4.8, invitedAt: now() },
    { operatorId: 'OP-004', restaurantId: 'REST-001', name: 'Andrea Vega', email: 'andrea.vega@mirestaurante.pe', phone: '+51 944 444 444', status: 'INVITED', completedDeliveries: 0, custodyRating: null, invitedAt: now() }
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

const findRestaurant = (id) => db.restaurants.find((r) => r.restaurantId === id);
const emailTaken = (email) =>
  db.users.some((u) => u.email === email) || db.operators.some((o) => o.email === email);

const sessionPayload = (user) => {
  const restaurant = findRestaurant(user.restaurantId);
  return {
    token: createToken(user),
    expiresIn: TOKEN_TTL_HOURS * 3600,
    user: {
      id: user.userId,
      email: user.email,
      name: user.name,
      role: user.role,
      restaurantId: user.restaurantId,
      restaurantName: restaurant?.name
    },
    subscription: subscriptionView(restaurant)
  };
};

const subscriptionView = (restaurant) =>
  restaurant ? { ...restaurant.subscription, details: PLANS[restaurant.subscription.plan] } : null;

const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Token inválido o expirado' });
  const user = db.users.find((u) => u.userId === data.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no existe' });
  req.user = user;
  req.restaurant = findRestaurant(user.restaurantId);
  next();
};

// Llamada HTTP a otro microservicio (no rompe si está caído)
const call = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, data: await res.json().catch(() => null) };
  } catch {
    return { ok: false, data: null };
  }
};

// Swagger
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const secured = [{ bearerAuth: [] }];

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - IAM & Subscriptions API',
    version: '2.0.0',
    description:
      'Autenticación, perfil del restaurante, operadores y suscripciones. US10, US11, US12, US15, US20.\n\n' +
      '**Cómo probar endpoints protegidos:** haz `POST /auth/login`, copia el `token` y pégalo en el botón **Authorize** (arriba a la derecha).\n\n' +
      'Cuenta demo: `admin@mirestaurante.pe` / `password123`'
  },
  servers: [
    { url: '/api/v1/iam', description: 'Vía API Gateway (:8080)' },
    { url: 'http://localhost:3001', description: 'Directo al servicio' }
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
  },
  paths: {
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Registrar restaurante + administrador (W02, US10). Devuelve sesión iniciada',
        requestBody: json({
          type: 'object',
          required: ['admin', 'restaurant'],
          properties: {
            admin: {
              type: 'object',
              required: ['name', 'email', 'password'],
              properties: {
                name: { type: 'string', example: 'Rosa Medina' },
                email: { type: 'string', example: 'rosa@lacevicheria.pe' },
                password: { type: 'string', example: 'segura123' }
              }
            },
            restaurant: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', example: 'La Cevichería' },
                ruc: { type: 'string', example: '20609876543' },
                phone: { type: 'string', example: '+51 955 123 456' },
                address: { type: 'string', example: 'Av. Grau 300, Barranco' }
              }
            }
          }
        }),
        responses: { 201: { description: 'Cuenta creada' }, 400: { description: 'Datos inválidos' }, 409: { description: 'Email ya registrado' } }
      }
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Iniciar sesión (W01, US11)',
        requestBody: json({
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string', example: 'admin@mirestaurante.pe' }, password: { type: 'string', example: 'password123' } }
        }),
        responses: { 200: { description: 'JWT + perfil + plan' }, 401: { description: 'Credenciales inválidas' } }
      }
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Solicitar recuperación de contraseña (W03, US20)',
        requestBody: json({ type: 'object', required: ['email'], properties: { email: { type: 'string', example: 'admin@mirestaurante.pe' } } }),
        responses: { 200: { description: 'Respuesta genérica (no revela si el email existe). En modo dev incluye devResetToken' } }
      }
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Restablecer contraseña con el token recibido',
        requestBody: json({
          type: 'object',
          required: ['token', 'newPassword'],
          properties: { token: { type: 'string' }, newPassword: { type: 'string', example: 'nueva1234' } }
        }),
        responses: { 200: { description: 'Contraseña actualizada' }, 400: { description: 'Token inválido/expirado o contraseña corta' } }
      }
    },
    '/users/me': {
      get: { tags: ['Perfil'], summary: 'Perfil del usuario y su restaurante (W15)', security: secured, responses: { 200: { description: 'Perfil' }, 401: { description: 'No autenticado' } } },
      put: {
        tags: ['Perfil'],
        summary: 'Actualizar perfil, datos del restaurante y configuración (W15)',
        security: secured,
        requestBody: json({
          type: 'object',
          properties: {
            name: { type: 'string', example: 'Diego Rivas' },
            restaurant: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' } } },
            settings: {
              type: 'object',
              example: { defaultThresholds: { COLD: { minTemperature: 1, maxTemperature: 6 } }, notifications: { criticalOnly: true } }
            }
          }
        }),
        responses: { 200: { description: 'Perfil actualizado' }, 400: { description: 'Datos inválidos' } }
      }
    },
    '/operators': {
      get: {
        tags: ['Operadores'],
        summary: 'Listar repartidores del restaurante (W11, US12)',
        security: secured,
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'INVITED', 'INACTIVE'] } }],
        responses: { 200: { description: 'Operadores' } }
      },
      post: {
        tags: ['Operadores'],
        summary: 'Invitar repartidor (valida email duplicado y límite del plan)',
        security: secured,
        requestBody: json({
          type: 'object',
          required: ['name', 'email'],
          properties: { name: { type: 'string', example: 'Mateo Flores' }, email: { type: 'string', example: 'mateo.flores@mirestaurante.pe' }, phone: { type: 'string', example: '+51 966 555 444' } }
        }),
        responses: { 201: { description: 'Operador invitado' }, 400: { description: 'Datos inválidos' }, 409: { description: 'Email duplicado o límite del plan' } }
      }
    },
    '/operators/{operatorId}/status': {
      patch: {
        tags: ['Operadores'],
        summary: 'Activar / desactivar repartidor',
        security: secured,
        parameters: [{ name: 'operatorId', in: 'path', required: true, schema: { type: 'string' }, example: 'OP-004' }],
        requestBody: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] } } }),
        responses: { 200: { description: 'Estado actualizado' }, 404: { description: 'No encontrado' } }
      }
    },
    '/subscriptions/plans': {
      get: { tags: ['Suscripción'], summary: 'Catálogo de planes (público)', responses: { 200: { description: 'Planes' } } }
    },
    '/subscriptions/current': {
      get: { tags: ['Suscripción'], summary: 'Plan actual del restaurante + uso (W14, US15)', security: secured, responses: { 200: { description: 'Suscripción' } } }
    },
    '/subscriptions/upgrade': {
      post: {
        tags: ['Suscripción'],
        summary: 'Cambiar de plan. Valida que cubra las cajas actuales (UF-WG6). Pago simulado: solo se guarda marca y últimos 4 dígitos',
        security: secured,
        requestBody: json({
          type: 'object',
          required: ['plan'],
          properties: {
            plan: { type: 'string', enum: ['STARTER', 'PRO', 'ENTERPRISE'], example: 'ENTERPRISE' },
            paymentMethod: { type: 'object', properties: { brand: { type: 'string', example: 'MASTERCARD' }, last4: { type: 'string', example: '5454' } } }
          }
        }),
        responses: { 200: { description: 'Plan actualizado' }, 400: { description: 'Plan inválido' }, 409: { description: 'El plan no cubre la flota actual' } }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Auth
app.post('/auth/register', (req, res) => {
  const { admin = {}, restaurant = {} } = req.body || {};
  const errors = {};
  if (!admin.name) errors['admin.name'] = 'Nombre requerido';
  if (!EMAIL_REGEX.test(admin.email || '')) errors['admin.email'] = 'Email inválido';
  if (!admin.password || admin.password.length < 8) errors['admin.password'] = 'Mínimo 8 caracteres';
  if (!restaurant.name) errors['restaurant.name'] = 'Nombre del restaurante requerido';
  if (restaurant.ruc && !/^\d{11}$/.test(restaurant.ruc)) errors['restaurant.ruc'] = 'RUC debe tener 11 dígitos';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });

  const email = admin.email.toLowerCase().trim();
  if (emailTaken(email)) return res.status(409).json({ error: 'El email ya está registrado' });

  const rest = {
    restaurantId: newId('REST'),
    name: restaurant.name,
    ruc: restaurant.ruc || null,
    phone: restaurant.phone || null,
    address: restaurant.address || null,
    settings: {
      defaultThresholds: { COLD: { minTemperature: 0, maxTemperature: 8 }, HOT: { minTemperature: 55, maxTemperature: 75 } },
      notifications: { email: true, push: true, criticalOnly: false }
    },
    subscription: { plan: 'STARTER', status: 'TRIAL', paymentMethod: null, startedAt: now(), renewsAt: new Date(Date.now() + 14 * 86400000).toISOString() },
    createdAt: now()
  };
  const user = { userId: newId('USR'), email, passwordHash: hashPassword(admin.password), name: admin.name, role: 'ADMINISTRATOR', restaurantId: rest.restaurantId, createdAt: now() };

  db.restaurants.push(rest);
  db.users.push(user);
  save();
  res.status(201).json({
    message: 'Restaurante registrado satisfactoriamente',
    ...sessionPayload(user),
    onboarding: { registerSmartBox: false, inviteOperator: false, choosePlan: false }
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const user = db.users.find((u) => u.email === String(email).toLowerCase().trim());
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  res.json({ message: 'Inicio de sesión exitoso', ...sessionPayload(user) });
});

app.post('/auth/forgot-password', (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const response = { message: 'Si el email está registrado, recibirás un enlace para restablecer tu contraseña' };
  const user = db.users.find((u) => u.email === email);
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    db.resetTokens = db.resetTokens.filter((t) => t.userId !== user.userId);
    db.resetTokens.push({ token, userId: user.userId, expiresAt: new Date(Date.now() + RESET_TTL_MIN * 60000).toISOString() });
    save();
    // Sin servicio de correo: en desarrollo devolvemos el token para poder probar
    if (process.env.NODE_ENV !== 'production') response.devResetToken = token;
  }
  res.json(response);
});

app.post('/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  const entry = db.resetTokens.find((t) => t.token === token);
  if (!entry || new Date(entry.expiresAt) < new Date()) return res.status(400).json({ error: 'Token inválido o expirado' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
  const user = db.users.find((u) => u.userId === entry.userId);
  user.passwordHash = hashPassword(newPassword);
  db.resetTokens = db.resetTokens.filter((t) => t !== entry);
  save();
  res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión' });
});

// Perfil
const profileView = (user, restaurant) => ({
  user: { id: user.userId, email: user.email, name: user.name, role: user.role },
  restaurant: { restaurantId: restaurant.restaurantId, name: restaurant.name, ruc: restaurant.ruc, phone: restaurant.phone, address: restaurant.address, settings: restaurant.settings },
  subscription: subscriptionView(restaurant)
});

app.get('/users/me', auth, (req, res) => {
  res.json(profileView(req.user, req.restaurant));
});

app.put('/users/me', auth, (req, res) => {
  const { name, restaurant, settings } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
    req.user.name = String(name).trim();
  }
  if (restaurant) {
    ['name', 'phone', 'address'].forEach((k) => {
      if (restaurant[k] !== undefined) req.restaurant[k] = restaurant[k];
    });
  }
  if (settings) {
    const s = req.restaurant.settings;
    for (const type of ['COLD', 'HOT']) {
      const t = settings.defaultThresholds?.[type];
      if (!t) continue;
      const merged = { ...s.defaultThresholds[type], ...t };
      if (Number(merged.minTemperature) >= Number(merged.maxTemperature)) {
        return res.status(400).json({ error: `Umbral ${type}: minTemperature debe ser menor que maxTemperature` });
      }
      s.defaultThresholds[type] = merged;
    }
    if (settings.notifications) s.notifications = { ...s.notifications, ...settings.notifications };
  }
  save();
  res.json(profileView(req.user, req.restaurant));
});

// Operadores
app.get('/operators', auth, (req, res) => {
  const { status } = req.query;
  res.json(db.operators.filter((o) => o.restaurantId === req.restaurant.restaurantId && (!status || o.status === status)));
});

app.post('/operators', auth, (req, res) => {
  const { name, email, phone } = req.body || {};
  const errors = {};
  if (!name) errors.name = 'Nombre requerido';
  if (!EMAIL_REGEX.test(email || '')) errors.email = 'Email inválido';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Datos inválidos', details: errors });

  const mail = email.toLowerCase().trim();
  if (emailTaken(mail)) return res.status(409).json({ error: 'Ya existe un usuario u operador con ese email' });

  const plan = PLANS[req.restaurant.subscription.plan];
  const current = db.operators.filter((o) => o.restaurantId === req.restaurant.restaurantId && o.status !== 'INACTIVE').length;
  if (plan.maxOperators !== null && current >= plan.maxOperators) {
    return res.status(409).json({ error: `Tu plan ${plan.name} permite hasta ${plan.maxOperators} operadores. Mejora tu plan para invitar más.` });
  }

  const operator = { operatorId: newId('OP'), restaurantId: req.restaurant.restaurantId, name, email: mail, phone: phone || null, status: 'INVITED', completedDeliveries: 0, custodyRating: null, invitedAt: now() };
  db.operators.push(operator);
  save();
  res.status(201).json({ ...operator, message: `Invitación enviada a ${mail}` });
});

app.patch('/operators/:operatorId/status', auth, (req, res) => {
  const op = db.operators.find((o) => o.operatorId === req.params.operatorId && o.restaurantId === req.restaurant.restaurantId);
  if (!op) return res.status(404).json({ error: 'Operador no encontrado' });
  const { status } = req.body || {};
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ error: 'status debe ser ACTIVE o INACTIVE' });
  op.status = status;
  op.updatedAt = now();
  save();
  res.json(op);
});

// Suscripciones
app.get('/subscriptions/plans', (req, res) => {
  res.json(Object.values(PLANS));
});

const fleetSize = async () => {
  const r = await call(`${CONTAINER_URL}/smartboxes`);
  return r.ok ? r.data.filter((b) => b.status !== 'DECOMMISSIONED').length : null;
};

app.get('/subscriptions/current', auth, async (req, res) => {
  const boxes = await fleetSize();
  const operators = db.operators.filter((o) => o.restaurantId === req.restaurant.restaurantId && o.status !== 'INACTIVE').length;
  res.json({ ...subscriptionView(req.restaurant), usage: { boxes, operators } });
});

app.post('/subscriptions/upgrade', auth, async (req, res) => {
  const { plan, paymentMethod } = req.body || {};
  const target = PLANS[plan];
  if (!target) return res.status(400).json({ error: 'Plan inválido. Usa STARTER, PRO o ENTERPRISE' });
  if (paymentMethod && !/^\d{4}$/.test(String(paymentMethod.last4 || ''))) {
    return res.status(400).json({ error: 'paymentMethod.last4 debe tener 4 dígitos (no envíes el número completo de tarjeta)' });
  }

  // UF-WG6: el plan debe cubrir la flota actual
  const boxes = await fleetSize();
  if (boxes !== null && target.maxBoxes !== null && boxes > target.maxBoxes) {
    return res.status(409).json({ error: `El plan ${target.name} permite ${target.maxBoxes} cajas y tu flota tiene ${boxes}. Elige un plan superior o da de baja cajas.` });
  }

  const sub = req.restaurant.subscription;
  sub.plan = target.plan;
  sub.status = 'ACTIVE';
  if (paymentMethod) sub.paymentMethod = { brand: paymentMethod.brand || 'CARD', last4: String(paymentMethod.last4) };
  sub.startedAt = now();
  sub.renewsAt = new Date(Date.now() + 30 * 86400000).toISOString();
  save();
  res.json({ message: `Plan actualizado a ${target.name}`, ...subscriptionView(req.restaurant), usage: { boxes } });
});

app.get('/health', (req, res) => {
  res.json({ service: 'iam-service', status: 'UP', timestamp: now() });
});

app.listen(PORT, () => {
  console.log(`[IAM-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});