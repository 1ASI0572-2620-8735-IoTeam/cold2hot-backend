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
