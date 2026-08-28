const heartbeatMs = 60_000;

console.log("Zaprosto worker started; notification processing is not implemented yet.");

const heartbeat = setInterval(() => {
  console.log("Zaprosto worker heartbeat.");
}, heartbeatMs);

function shutdown(signal: NodeJS.Signals) {
  console.log(`Zaprosto worker received ${signal}; shutting down.`);
  clearInterval(heartbeat);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
