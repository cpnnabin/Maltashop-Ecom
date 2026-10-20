const {
  buildStockReservedEvent,
  buildStockRejectedEvent,
  parseOrderPlaced,
  InvalidEventError,
  ROUTING_KEYS
} = require('../src/events');

const orderId = '11111111-1111-4111-8111-111111111111';
const correlationId = 'test-correlation-123';

function validOrderPlaced() {
  return {
    eventId: '33333333-3333-4333-8333-333333333333',
    type: 'OrderPlaced',
    version: 1,
    occurredAt: '2026-10-20T10:00:00Z',
    correlationId,
    data: { orderId, customerId: 'cust-1', items: [{ sku: 'SKU-100', quantity: 2 }] }
  };
}

describe('parseOrderPlaced', () => {
  test('reads a valid OrderPlaced event', () => {
    expect(parseOrderPlaced(validOrderPlaced())).toEqual({
      eventId: '33333333-3333-4333-8333-333333333333',
      orderId,
      customerId: 'cust-1',
      items: [{ sku: 'SKU-100', quantity: 2 }],
      correlationId
    });
  });

  test('refuses an event without items, or with too many', () => {
    const none = validOrderPlaced();
    none.data.items = [];
    expect(() => parseOrderPlaced(none)).toThrow(InvalidEventError);
    const many = validOrderPlaced();
    many.data.items = Array.from({ length: 21 }, (_, i) => ({ sku: `SKU-${100 + i}`, quantity: 1 }));
    expect(() => parseOrderPlaced(many)).toThrow(InvalidEventError);
  });

  test('refuses a bad quantity or sku', () => {
    for (const item of [{ sku: 'SKU-100', quantity: 0 }, { sku: 'SKU-100', quantity: 1.5 }, { sku: 'SKU-100', quantity: '2' }, { sku: 'ab', quantity: 1 }, { quantity: 1 }]) {
      const event = validOrderPlaced();
      event.data.items = [item];
      expect(() => parseOrderPlaced(event)).toThrow(InvalidEventError);
    }
  });

  test('refuses a missing or malformed orderId and a missing customerId', () => {
    const noOrder = validOrderPlaced();
    delete noOrder.data.orderId;
    expect(() => parseOrderPlaced(noOrder)).toThrow(InvalidEventError);
    const badOrder = validOrderPlaced();
    badOrder.data.orderId = 'not-a-uuid';
    expect(() => parseOrderPlaced(badOrder)).toThrow(InvalidEventError);
    const noCustomer = validOrderPlaced();
    delete noCustomer.data.customerId;
    expect(() => parseOrderPlaced(noCustomer)).toThrow(InvalidEventError);
  });

  test('refuses the wrong type, the wrong version and non-objects', () => {
    expect(() => parseOrderPlaced({ ...validOrderPlaced(), type: 'StockReserved' })).toThrow(InvalidEventError);
    expect(() => parseOrderPlaced({ ...validOrderPlaced(), version: 2 })).toThrow(InvalidEventError);
    expect(() => parseOrderPlaced(null)).toThrow(InvalidEventError);
    expect(() => parseOrderPlaced('text')).toThrow(InvalidEventError);
  });
});

describe('event builders', () => {
  test('StockReserved carries the orderId and correlation ID', () => {
    const event = buildStockReservedEvent({ orderId, correlationId });
    expect(event).toMatchObject({ type: 'StockReserved', version: 1, correlationId, data: { orderId } });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('StockRejected also carries the reason', () => {
    const event = buildStockRejectedEvent({ orderId, reason: 'Insufficient stock for SKU-200', correlationId });
    expect(event).toMatchObject({ type: 'StockRejected', version: 1, correlationId, data: { orderId, reason: 'Insufficient stock for SKU-200' } });
  });

  test('routing keys match what the Order service listens on', () => {
    expect(ROUTING_KEYS.STOCK_RESERVED).toBe('stock.reserved');
    expect(ROUTING_KEYS.STOCK_REJECTED).toBe('stock.rejected');
    expect(ROUTING_KEYS.ORDER_PLACED).toBe('order.placed');
  });
});
