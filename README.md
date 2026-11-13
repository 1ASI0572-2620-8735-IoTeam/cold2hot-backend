# Cold2Hot Backend · Ecosistema de Microservicios IoT

Arquitectura de microservicios distribuida para la plataforma **Cold2Hot**, diseñada bajo **Domain-Driven Design (DDD)** y orientada a la custodia térmica de alimentos en delivery de última milla.

## 🏛️ Arquitectura de Microservicios

La solución desacopla las responsabilidades del sistema en servicios autónomos basados en los Bounded Contexts del Capítulo IV:

| Servicio | Puerto Local | Contexto DDD | Responsabilidad Principal |
| :--- | :--- | :--- | :--- |
| **`api-gateway`** | `8080` | Perímetro | Enrutador inverso, unificación de Swagger, gestión de CORS y seguridad. |
| **`iam-service`** | `3001` | Generic | Autenticación, registro de restaurantes, usuarios y emisión de tokens JWT. |
| **`telemetry-service`** | `3002` | Core (IoT) | Ingesta masiva de lecturas del sensor DS18B20, evaluación térmica y bitácora. |
| **`container-service`** | `3003` | Supporting | Inventario de cajas SmartBox y emparejamiento con hardware ESP32 NodeMCU. |
| **`security-service`** | `3004` | Core | Generación/validación de códigos OTP y detección de intrusión (Reed Switch). |
| **`orders-service`** | `3005` | Supporting | Órdenes de despacho, trazabilidad y reporte final de auditoría. |

---

## 🚀 Cómo ejecutar con Docker Compose

Para levantar todo el ecosistema de microservicios en simultáneo:

```bash
docker compose up --build
```

Una vez levantado:
* **API Gateway**: [http://localhost:8080](http://localhost:8080)
* **Documentación OpenAPI / Swagger unificada**: [http://localhost:8080/docs](http://localhost:8080/docs)

---

## 🧪 Pruebas automatizadas

La suite usa el runner nativo de Node (`node:test`), sin dependencias adicionales (Node 20 o superior).

```bash
npm test          # unitarias + integración (45 pruebas)
npm run test:unit # solo reglas de negocio puras
```

- `tests/unit.test.js`: reglas puras del Security Service (evaluación de OTP, lógica de dos niveles de apertura, utilidades).
- `tests/integration.test.js`: levanta el orquestador completo (5 microservicios y API Gateway) en puertos libres, con archivos de datos temporales y sin `DATABASE_URL`, y recorre los flujos de las historias US03, US04, US05, US07, US09, US10, US11, US12, US13, US14, US16, US17 y US20 a través del Gateway.
- Las pruebas no tocan Supabase ni dejan datos en `data/`. El workflow `.github/workflows/test.yml` las ejecuta en cada push y Pull Request a `master` y `develop`.

## 🗄️ Persistencia (PostgreSQL / Supabase)

Con `DATABASE_URL` definida, cada microservicio guarda sus datos en **tablas relacionales propias** (prefijo por servicio). El DDL de cada uno está en `<servicio>/src/schema.sql`, es idempotente y **se aplica solo al arrancar**: no hay que correr migraciones a mano. Sin `DATABASE_URL`, el servicio usa un archivo JSON local (`<servicio>/data/db.json`), pensado solo para desarrollo.

| Servicio | Tablas |
| :--- | :--- |
| `iam-service` | `iam_restaurants`, `iam_subscriptions`, `iam_users`, `iam_operators`, `iam_password_resets` (solo el hash SHA-256 del token) |
| `telemetry-service` | `telemetry_profiles`, `telemetry_readings`, `telemetry_alerts` |
| `container-service` | `container_smartboxes`, `container_alerts` |
| `security-service` | `security_otps`, `security_locks`, `security_access_attempts`, `security_tamper_events`, `security_alerts` |
| `orders-service` | `orders`, `orders_evidence`, `orders_audit_reports` (un trigger impide modificar o borrar un reporte consolidado) |

* Reglas de negocio que garantiza la base: un solo envío en curso por SmartBox, un solo perfil térmico activo por caja, una sola alerta abierta por envío/caja, MAC/serie/dispositivo únicos y emails únicos.
* Todas las tablas tienen RLS activado sin políticas: solo el backend (rol `postgres`) accede; la API pública de Supabase queda bloqueada.
* La primera vez que un servicio encuentra sus tablas vacías importa su documento anterior de `public.service_state` (o el seed si no existe). Esa tabla ya no se usa después.
* `DATABASE_SCHEMA=<nombre>` hace que los servicios trabajen en otro esquema del mismo proyecto (útil para pruebas sin tocar `public`).

### Fotos de evidencia (Supabase Storage)

`POST /api/v1/orders/{orderId}/evidence` con `photoBase64` sube la imagen (JPEG, PNG o WebP, máx. 5 MB) al bucket público `delivery-evidence` en la ruta `orders/<orderId>/<uuid>.<ext>`, y en la base solo queda su URL. El bucket se crea solo al arrancar. Si Storage no está configurado, la foto se guarda en Base64 en `orders_evidence` y se sube automáticamente al Storage en el siguiente arranque con las claves configuradas. Los listados de envíos nunca incluyen el Base64.

### Variables de entorno

| Variable | Uso |
| :--- | :--- |
| `DATABASE_URL` | Cadena de conexión del *Session pooler* de Supabase (puerto 5432). |
| `SUPABASE_URL` | `https://<ref>.supabase.co`, para Storage. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave `service_role` (o secret key `sb_secret_...`) para subir fotos. Nunca exponerla en el frontend. |
| `JWT_SECRET` | Firma de los tokens de sesión. **Obligatoria en producción** (si falta se usa una clave de desarrollo). |
| `EVIDENCE_BUCKET` | Opcional, nombre del bucket (por defecto `delivery-evidence`). |
| `DATABASE_SCHEMA` | Opcional, esquema de trabajo (por defecto `public`). |
