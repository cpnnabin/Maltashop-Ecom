const {
  buildOrderPlacedEvent,
  parseStockOutcome,
  InvalidEventError,
  ROUTING_KEYS
} = require('../src/events');

const orderId = '11111111-1111-4111-8111-111111111111';
const correlationId = 'test-correlation-123';

describe('buildOrderPlacedEvent', () => {
  test('builds the envelope described in contracts/order-placed.schema.json', () => {
    const event = buildOrderPlacedEvent({
      orderId,
      customerId: 'cust-1',
      items: [{ sku: 'SKU-100', quantity: 2 }],
      correlationId
    });
    expect(event.type).toBe('OrderPlaced');
    expect(event.version).toBe(1);
    expect(event.correlationId).toBe(correlationId);
    expect(event.data).toEqual({ orderId, customerId: 'cust-1', items: [{ sku: 'SKU-100', quantity: 2 }] });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('every event gets its own eventId', () => {
    const args = { orderId, customerId: 'c', items: [{ sku: 'SKU-100', quantity: 1 }], correlationId };
    expect(buildOrderPlacedEvent(args).eventId).not.toBe(buildOrderPlacedEvent(args).eventId);
  });

  test('uses the routing keys the Inventory service listens on', () => {
    expect(ROUTING_KEYS.ORDER_PLACED).toBe('order.placed');
    expect(ROUTING_KEYS.STOCK_RESERVED).toBe('stock.reserved');
    expect(ROUTING_KEYS.STOCK_REJECTED).toBe('stock.rejected');
  });
});

describe('parseStockOutcome', () => {
  const base = { eventId: '22222222-2222-4222-8222-222222222222', version: 1, occurredAt: '2026-10-20T10:00:00Z', correlationId };

  test('StockReserved means CONFIRMED', () => {
    const outcome = parseStockOutcome({ ...base, type: 'StockReserved', data: { orderId } });
    expect(outcome).toMatchObject({ orderId, status: 'CONFIRMED', correlationId });
  });

  test('StockRejected means CANCELLED and keeps the reason', () => {
    const outcome = parseStockOutcome({ ...base, type: 'StockRejected', data: { orderId, reason: 'Insufficient stock for SKU-200' } });
    expect(outcome).toMatchObject({ orderId, status: 'CANCELLED', reason: 'Insufficient stock for SKU-200' });
  });

  test('rejects a StockRejected without a reason', () => {
    expect(() => parseStockOutcome({ ...base, type: 'StockRejected', data: { orderId } })).toThrow(InvalidEventError);
  });

  test('rejects an unknown event type', () => {
    expect(() => parseStockOutcome({ ...base, type: 'SomethingElse', data: { orderId } })).toThrow(InvalidEventError);
  });

  test('rejects an unsupported version', () => {
    expect(() => parseStockOutcome({ ...base, version: 2, type: 'StockReserved', data: { orderId } })).toThrow(InvalidEventError);
  });

  test('rejects a missing or malformed orderId', () => {
    expect(() => parseStockOutcome({ ...base, type: 'StockReserved', data: {} })).toThrow(InvalidEventError);
    expect(() => parseStockOutcome({ ...base, type: 'StockReserved', data: { orderId: 'not-a-uuid' } })).toThrow(InvalidEventError);
  });

  test('rejects something that is not an object', () => {
    expect(() => parseStockOutcome(null)).toThrow(InvalidEventError);
    expect(() => parseStockOutcome('hello')).toThrow(InvalidEventError);
  });

  test('InvalidEventError is marked permanent so the consumer never retries it', () => {
    expect(new InvalidEventError('x').permanent).toBe(true);
  });
});
