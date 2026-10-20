const express = require('express');
const { randomUUID } = require('node:crypto');
const db = require('./db');
const rabbit = require('./rabbit');
const saga = require('./saga');
const { UUID_RE } = require('./events');
const { validateOrderRequest, isValidCorrelationId } = require('./validation');
const { withCorrelationId } = require('./logger');

const app = express();

// Correlation-ID middleware: reuse a valid client-supplied ID, otherwise generate one.
app.use((req, res, next) => {
  const supplied = req.headers['x-correlation-id'];
  const correlationId = isValidCorrelationId(supplied) ? supplied : randomUUID();
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  next();
});

app.use(express.json());

// Liveness: the process is up.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'order-service' });
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
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready', service: 'order-service', checks });
});

app.post('/orders', async (req, res) => {
  const log = withCorrelationId(req.correlationId);
  const validation = validateOrderRequest(req.body);
  if (!validation.ok) {
    log.warn({ details: validation.errors }, 'Rejected invalid order request');
    return res.status(400).json({ error: 'Invalid request', details: validation.errors });
  }
  try {
    const result = await saga.placeOrder(validation.value, req.correlationId);
    log.info({ orderId: result.orderId }, 'Place-order accepted');
    res.status(202).json(result);
  } catch (err) {
    log.error({ err }, 'Place-order failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/orders/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid order id' });
  }
  try {
    const order = await db.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json(order);
  } catch (err) {
    withCorrelationId(req.correlationId).error({ err }, 'Order lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Malformed JSON bodies get a clean 400 instead of a stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  withCorrelationId(req.correlationId).error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
