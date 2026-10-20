/**
 * Event envelopes exchanged over RabbitMQ (see ../../contracts/*.schema.json).
 *
 * This file has NO dependencies on purpose, so the contract tests can load it without
 * a database, a broker or any npm package.
 *
 *   Order service     --OrderPlaced-->                    Inventory service   (order.placed)
 *   Inventory service --StockReserved / StockRejected-->  Order service       (stock.reserved / stock.rejected)
 */
const { randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 1;

const ROUTING_KEYS = {
  ORDER_PLACED: 'order.placed',
  STOCK_RESERVED: 'stock.reserved',
  STOCK_REJECTED: 'stock.rejected'
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A message that can never be processed successfully (retrying will not help). */
class InvalidEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidEventError';
    this.permanent = true;
  }
}

function buildOrderPlacedEvent({ orderId, customerId, items, correlationId, eventId, occurredAt }) {
  return {
    eventId: eventId || randomUUID(),
    type: 'OrderPlaced',
    version: SCHEMA_VERSION,
    occurredAt: occurredAt || new Date().toISOString(),
    correlationId,
    data: {
      orderId,
      customerId,
      items: items.map((item) => ({ sku: item.sku, quantity: item.quantity }))
    }
  };
}

/**
 * Reads a StockReserved / StockRejected event and tells the Order service what to do:
 *   StockReserved -> { status: 'CONFIRMED' }
 *   StockRejected -> { status: 'CANCELLED', reason }
 * Throws InvalidEventError for anything else.
 */
function parseStockOutcome(event) {
  if (!event || typeof event !== 'object') {
    throw new InvalidEventError('Event must be a JSON object');
  }
  if (event.version !== SCHEMA_VERSION) {
    throw new InvalidEventError(`Unsupported event version: ${event.version}`);
  }
  const data = event.data;
  if (!data || typeof data !== 'object' || !UUID_RE.test(String(data.orderId))) {
    throw new InvalidEventError('Event data.orderId must be a UUID');
  }
  const base = { eventId: event.eventId, orderId: data.orderId, correlationId: event.correlationId };

  switch (event.type) {
    case 'StockReserved':
      return { ...base, status: 'CONFIRMED' };
    case 'StockRejected':
      if (typeof data.reason !== 'string' || data.reason.length === 0) {
        throw new InvalidEventError('StockRejected requires data.reason');
      }
      return { ...base, status: 'CANCELLED', reason: data.reason };
    default:
      throw new InvalidEventError(`Unsupported event type: ${event.type}`);
  }
}

module.exports = {
  SCHEMA_VERSION,
  ROUTING_KEYS,
  UUID_RE,
  InvalidEventError,
  buildOrderPlacedEvent,
  parseStockOutcome
};
