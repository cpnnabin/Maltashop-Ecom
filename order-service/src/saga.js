const { randomUUID } = require('node:crypto');
const db = require('./db');
const rabbit = require('./rabbit');
const { withCorrelationId } = require('./logger');
const { ROUTING_KEYS, buildOrderPlacedEvent, parseStockOutcome } = require('./events');

/**
 * Step 1 of the saga: save the order as PENDING and announce it.
 * If the event cannot be published, the order is cancelled so it never stays PENDING silently.
 */
async function placeOrder({ customerId, productId, quantity }, correlationId) {
  const log = withCorrelationId(correlationId);
  const orderId = randomUUID();

  await db.createOrder({
    id: orderId,
    customerId,
    productId,
    quantity,
    status: 'PENDING',
    correlationId
  });
  log.info({ orderId, productId, quantity }, 'Order created in PENDING state');

  const event = buildOrderPlacedEvent({
    orderId,
    customerId,
    items: [{ sku: productId, quantity }],
    correlationId
  });

  try {
    await rabbit.publish(ROUTING_KEYS.ORDER_PLACED, event, correlationId);
  } catch (err) {
    log.error({ err, orderId }, 'Could not publish OrderPlaced - cancelling the order');
    await db.transitionFromPending(orderId, 'CANCELLED', 'Order could not be sent for processing');
    throw err;
  }
  log.info({ orderId, eventId: event.eventId }, 'OrderPlaced event published');

  return { orderId, status: 'PENDING' };
}

/**
 * Final step of the saga: apply the Inventory service's answer.
 *   StockReserved -> CONFIRMED
 *   StockRejected -> CANCELLED (compensating action)
 * Safe to call more than once with the same event (idempotent).
 * Throws InvalidEventError for a message it cannot understand (the consumer dead-letters it).
 */
async function handleStockOutcome(rawEvent, context = {}) {
  const outcome = parseStockOutcome(rawEvent);
  const log = withCorrelationId(outcome.correlationId || context.correlationId);

  const changed = await db.transitionFromPending(outcome.orderId, outcome.status, outcome.reason || null);
  if (changed) {
    log.info({ orderId: outcome.orderId, status: outcome.status, reason: outcome.reason }, `Order ${outcome.status}`);
    return { applied: true, status: outcome.status };
  }

  const existing = await db.getOrder(outcome.orderId);
  if (!existing) {
    log.warn({ orderId: outcome.orderId }, 'Stock outcome received for unknown order - ignoring');
    return { applied: false, ignored: 'UNKNOWN_ORDER' };
  }
  if (existing.status === outcome.status) {
    log.info({ orderId: outcome.orderId, status: existing.status }, 'Duplicate stock outcome - idempotent no-op');
    return { applied: false, ignored: 'DUPLICATE' };
  }
  log.warn(
    { orderId: outcome.orderId, current: existing.status, received: outcome.status },
    'Conflicting stock outcome for an order that is already decided - ignoring'
  );
  return { applied: false, ignored: 'CONFLICT' };
}

module.exports = { placeOrder, handleStockOutcome };
