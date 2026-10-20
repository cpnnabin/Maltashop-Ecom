const db = require('./db');
const rabbit = require('./rabbit');
const handlers = require('./handlers');
const app = require('./app');
const { logger } = require('./logger');

let server;

async function start() {
  await db.init();
  await rabbit.connect(); // declares the queue before the service reports healthy
  await rabbit.consumeOrderPlaced(handlers.handleOrderPlaced);
  const port = process.env.PORT || 3001;
  server = app.listen(port, () => {
    logger.info({ port }, 'Inventory service listening');
  });
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rabbit.close();
    await db.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  logger.error({ err }, 'Inventory service failed to start');
  process.exit(1);
});
