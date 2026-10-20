const express = require('express');
const db = require('./db');
const rabbit = require('./rabbit');
const { logger } = require('./logger');

const app = express();
app.use(express.json());

// Liveness: the process is up.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'inventory-service' });
});

// Readiness: the database and the broker are reachable.
app.get('/ready', async (req, res) => {
  const checks = { database: 'ok', broker: rabbit.isConnected() ? 'ok' : 'down' };
  try {
    await db.ping();
  } catch (err) {
    checks.database = 'down';
  }
  const ready = checks.database === 'ok' && checks.broker === 'ok';
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready', service: 'inventory-service', checks });
});

// Read-only view of the stock level (handy for demos and the smoke test).
app.get('/stock/:productId', async (req, res) => {
  try {
    const available = await db.getStock(req.params.productId);
    res.json({ productId: req.params.productId, available });
  } catch (err) {
    logger.error({ err }, 'Stock lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;
