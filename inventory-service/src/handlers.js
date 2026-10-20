const db = require('./db');
const rabbit = require('./rabbit');
const { withCorrelationId } = require('./logger');
const {
  ROUTING_KEYS,
  parseOrderPlaced,
  buildStockReservedEvent,
  buildStockRejectedEvent
} = require('./events');

/**
 * Inventory side of the saga. For every OrderPlaced event:
 *   1. decide once (reserve or reject) in a local transaction - duplicates return the stored decision;
 *   2. publish the matching answer: StockReserved or StockRejected.
 *
 * The answer is published again for a duplicate. That is deliberate: if the service crashed after
 * saving its decision but before publishing, the redelivered message repairs it. The Order service
 * ignores answers it has already applied.
 */
async function handleOrderPlaced(rawEvent, context = {}) {
  const event = parseOrderPlaced(rawEvent); // throws InvalidEventError for a bad message
  const correlationId = event.correlationId || context.correlationId;
  const log = withCorrelationId(correlationId);
  log.info({ orderId: event.orderId, items: event.items }, 'Received OrderPlaced');

  const result = await db.reserve({ orderId: event.orderId, items: event.items, correlationId });

  if (result.outcome === 'RESERVED') {
    log.info({ orderId: event.orderId, duplicate: result.duplicate }, 'Stock reserved - publishing StockReserved');
    await rabbit.publish(
      ROUTING_KEYS.STOCK_RESERVED,
      buildStockReservedEvent({ orderId: event.orderId, correlationId }),
      correlationId
    );
  } else {
    log.warn(
      { orderId: event.orderId, reason: result.reason, duplicate: result.duplicate },
      'Stock rejected - publishing StockRejected'
    );
    await rabbit.publish(
      ROUTING_KEYS.STOCK_REJECTED,
      buildStockRejectedEvent({ orderId: event.orderId, reason: result.reason, correlationId }),
      correlationId
    );
  }
  return result;
}

module.exports = { handleOrderPlaced };
