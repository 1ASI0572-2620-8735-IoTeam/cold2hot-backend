const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Documentación OpenAPI / Swagger
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Cold2Hot - IAM Microservice API',
    version: '1.0.0',
    description: 'Microservicio para autenticación, gestión de identidades y roles de la plataforma Cold2Hot.'
  },
  paths: {
    '/auth/login': {
      post: {
        summary: 'Iniciar sesión de administrador o repartidor',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', example: 'admin@mirestaurante.pe' },
                  password: { type: 'string', example: 'password123' }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Autenticación exitosa y retorno de JWT' },
          401: { description: 'Credenciales inválidas' }
        }
      }
    },
    '/auth/register': {
      post: {
        summary: 'Registrar nuevo restaurante y cuenta de administrador',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  restaurantName: { type: 'string', example: 'La Pérgola' },
                  email: { type: 'string', example: 'contacto@lapergola.pe' },
                  password: { type: 'string', example: 'segura123' }
                }
              }
            }
          }
        },
        responses: {
          201: { description: 'Cuenta creada exitosamente' }
        }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Endpoints
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }

  res.json({
    message: 'Inicio de sesión exitoso',
    token: 'jwt-cold2hot-sample-token-' + Date.now(),
    user: {
      id: 'USR-001',
      email,
      name: email.split('@')[0],
      role: 'ADMINISTRATOR',
      restaurantName: 'La Pergola Delivery'
    }
  });
});

app.post('/auth/register', (req, res) => {
  const { restaurantName, email } = req.body;
  res.status(201).json({
    message: 'Restaurante registrado satisfactoriamente',
    restaurantId: 'REST-' + Math.floor(100 + Math.random() * 900),
    restaurantName,
    email
  });
});

app.get('/health', (req, res) => {
  res.json({ service: 'iam-service', status: 'UP', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[IAM-SERVICE] Escuchando en el puerto ${PORT}. Swagger disponible en http://localhost:${PORT}/docs`);
});
