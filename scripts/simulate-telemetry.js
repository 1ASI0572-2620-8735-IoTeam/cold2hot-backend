/**
 * Simulador de SmartBox (ESP32 + DS18B20): envía una lectura por envío activo cada N segundos
 * a través del API Gateway, igual que lo haría el firmware real.
 * Uso: node scripts/simulate-telemetry.js [gatewayUrl] [intervaloSeg]
 */
const GATEWAY = process.argv[2] || process.env.GATEWAY_URL || 'http://localhost:8080';
const INTERVAL = Number(process.argv[3] || 5) * 1000;
const temps = {};

const tick = async () => {
  try {
    const res = await fetch(`${GATEWAY}/api/v1/orders/shipments?status=IN_TRANSIT`);
    const shipments = await res.json();
    for (const s of shipments) {
      const mid = (s.minTemp + s.maxTemp) / 2;
      const prev = temps[s.shipmentId] ?? mid;
      // Deriva suave hacia afuera del rango para que ocasionalmente se genere un desvío
      const next = Math.round((prev + (Math.random() - 0.52) * 1.2) * 10) / 10;
      temps[s.shipmentId] = next;
      await fetch(`${GATEWAY}/api/v1/telemetry/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smartBoxId: s.smartBoxId, shipmentId: s.shipmentId, temperature: next, lidOpen: false })
      });
      await fetch(`${GATEWAY}/api/v1/containers/devices/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxId: s.smartBoxId, batteryLevel: 80 })
      });
      console.log(`[SIM] ${s.shipmentId} ${s.smartBoxId} -> ${next}°C`);
    }
  } catch (e) {
    console.warn('[SIM] Gateway no disponible:', e.message);
  }
};
console.log(`[SIM] Simulando telemetría contra ${GATEWAY} cada ${INTERVAL / 1000}s`);
tick();
setInterval(tick, INTERVAL);
