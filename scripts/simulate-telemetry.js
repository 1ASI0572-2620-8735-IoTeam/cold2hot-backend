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
    const res = await fetch(`${GATEWAY}/api/v1/orders?status=IN_TRANSIT`);
    const shipments = await res.json();
    for (const s of shipments) {
      const { minTemperature: lo, maxTemperature: hi } = s.thermalProfile;
      const mid = (lo + hi) / 2;
      const prev = temps[s.orderId] ?? mid;
      // Ruido con reversión a la media: casi siempre en rango y, de vez en cuando, un desvío
      const spike = Math.random() < 0.03 ? (Math.random() < 0.5 ? -1 : 1) * (hi - lo) * 0.8 : 0;
      const next = Math.round((prev + (mid - prev) * 0.25 + (Math.random() - 0.5) * 1.2 + spike) * 10) / 10;
      temps[s.orderId] = next;
      await fetch(`${GATEWAY}/api/v1/telemetry/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smartBoxId: s.smartBoxId, shipmentId: s.orderId, temperature: next, lidOpen: false })
      });
      await fetch(`${GATEWAY}/api/v1/containers/devices/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxId: s.smartBoxId, batteryLevel: 80 })
      });
      console.log(`[SIM] ${s.orderId} ${s.smartBoxId} -> ${next}°C`);
    }
  } catch (e) {
    console.warn('[SIM] Gateway no disponible:', e.message);
  }
};
console.log(`[SIM] Simulando telemetría contra ${GATEWAY} cada ${INTERVAL / 1000}s`);
tick();
setInterval(tick, INTERVAL);
