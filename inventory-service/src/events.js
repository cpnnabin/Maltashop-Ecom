/**
 * Event envelopes exchanged over RabbitMQ (see ../../contracts/*.schema.json).
 * No dependencies on purpose, so the contract tests can load this file on its own.
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

function buildStockReservedEvent({ orderId, correlationId, eventId, occurredAt }) {
  return {
    eventId: eventId || randomUUID(),
    type: 'StockReserved',
    version: SCHEMA_VERSION,
    occurredAt: occurredAt || new Date().toISOString(),
    correlationId,
    data: { orderId }
  };
}

function buildStockRejectedEvent({ orderId, reason, correlationId, eventId, occurredAt }) {
  return {
    eventId: eventId || randomUUID(),
    type: 'StockRejected',
    version: SCHEMA_VERSION,
    occurredAt: occurredAt || new Date().toISOString(),
    correlationId,
    data: { orderId, reason }
  };
}

/**
 * Reads an OrderPlaced event and returns { eventId, orderId, customerId, items, correlationId }.
 * Throws InvalidEventError if the message does not follow contracts/order-placed.schema.json.
 */
function parseOrderPlaced(event) {
  if (!event || typeof event !== 'object') {
    throw new InvalidEventError('Event must be a JSON object');
  }
  if (event.type !== 'OrderPlaced') {
    throw new InvalidEventError(`Unsupported event type: ${event.type}`);
  }
  if (event.version !== SCHEMA_VERSION) {
    throw new InvalidEventError(`Unsupported event version: ${event.version}`);
  }
  const data = event.data;
  if (!data || typeof data !== 'object') {
    throw new InvalidEventError('Event data is missing');
  }
  if (!UUID_RE.test(String(data.orderId))) {
    throw new InvalidEventError('data.orderId must be a UUID');
  }
  if (typeof data.customerId !== 'string' || data.customerId.length < 1 || data.customerId.length > 100) {
    throw new InvalidEventError('data.customerId must be a string of 1-100 characters');
  }
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 20) {
    throw new InvalidEventError('data.items must contain 1-20 items');
  }
  const items = data.items.map((item, index) => {
    if (!item || typeof item.sku !== 'string' || item.sku.length < 3 || item.sku.length > 40) {
      throw new InvalidEventError(`data.items[${index}].sku must be a string of 3-40 characters`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) {
      throw new InvalidEventError(`data.items[${index}].quantity must be a whole number from 1 to 100`);
    }
    return { sku: item.sku, quantity: item.quantity };
  });
  return {
    eventId: event.eventId,
    orderId: data.orderId,
    customerId: data.customerId,
    items,
    correlationId: event.correlationId
  };
}

module.exports = {
  SCHEMA_VERSION,
  ROUTING_KEYS,
  UUID_RE,
  InvalidEventError,
  buildStockReservedEvent,
  buildStockRejectedEvent,
  parseOrderPlaced
};
