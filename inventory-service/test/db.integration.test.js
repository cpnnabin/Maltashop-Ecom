// Runs against a REAL PostgreSQL database. Skipped unless TEST_DATABASE_URL is set, for example:
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/test npm run test:db
// (The GitHub Actions workflow starts a PostgreSQL service and sets it.)
const { randomUUID } = require('node:crypto');

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('inventory database (real PostgreSQL)', () => {
  let db;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = require('../src/db');
    await db.init();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE reservations CASCADE');
    await db.pool.query('DELETE FROM stock');
    await db.pool.query(`INSERT INTO stock (product_id, available) VALUES ('TEST-A', 10), ('TEST-B', 3)`);
  });

  const correlationId = 'corr-12345';
  const stockOf = (sku) => db.getStock(sku);

  test('init can run twice and seeds the demo products', async () => {
    await db.init();
    await db.init();
    expect(await stockOf('SKU-100')).toBeGreaterThan(0);
  });

  test('reserves stock and records the decision', async () => {
    const orderId = randomUUID();
    const result = await db.reserve({ orderId, items: [{ sku: 'TEST-A', quantity: 4 }], correlationId });

    expect(result).toEqual({ outcome: 'RESERVED', reason: null, duplicate: false });
    expect(await stockOf('TEST-A')).toBe(6);
    const rows = await db.pool.query('SELECT status FROM reservations WHERE order_id = $1', [orderId]);
    expect(rows.rows[0].status).toBe('RESERVED');
    const items = await db.pool.query('SELECT product_id, quantity FROM reservation_items WHERE order_id = $1', [orderId]);
    expect(items.rows).toEqual([{ product_id: 'TEST-A', quantity: 4 }]);
  });

  test('rejects an order with insufficient stock, leaves stock alone and records REJECTED', async () => {
    const orderId = randomUUID();
    const result = await db.reserve({ orderId, items: [{ sku: 'TEST-B', quantity: 4 }], correlationId });

    expect(result.outcome).toBe('REJECTED');
    expect(result.reason).toBe('Insufficient stock for TEST-B');
    expect(await stockOf('TEST-B')).toBe(3);
    const rows = await db.pool.query('SELECT status, reason FROM reservations WHERE order_id = $1', [orderId]);
    expect(rows.rows[0]).toEqual({ status: 'REJECTED', reason: 'Insufficient stock for TEST-B' });
  });

  test('rejects an unknown product', async () => {
    const result = await db.reserve({ orderId: randomUUID(), items: [{ sku: 'NO-SUCH-SKU', quantity: 1 }], correlationId });
    expect(result.outcome).toBe('REJECTED');
    expect(result.reason).toBe('Unknown product NO-SUCH-SKU');
  });

  test('a duplicate delivery does not reserve twice and returns the stored decision', async () => {
    const orderId = randomUUID();
    const items = [{ sku: 'TEST-A', quantity: 4 }];
    const first = await db.reserve({ orderId, items, correlationId });
    const second = await db.reserve({ orderId, items, correlationId });

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ outcome: 'RESERVED', reason: null, duplicate: true });
    expect(await stockOf('TEST-A')).toBe(6);
  });

  test('a rejected order stays rejected when the message is redelivered after a restock', async () => {
    const orderId = randomUUID();
    const items = [{ sku: 'TEST-B', quantity: 4 }];
    await db.reserve({ orderId, items, correlationId });
    await db.pool.query(`UPDATE stock SET available = 100 WHERE product_id = 'TEST-B'`);

    const again = await db.reserve({ orderId, items, correlationId });

    expect(again.outcome).toBe('REJECTED');
    expect(again.duplicate).toBe(true);
    expect(await stockOf('TEST-B')).toBe(100);
  });

  test('a multi-item order is all-or-nothing', async () => {
    const orderId = randomUUID();
    const result = await db.reserve({
      orderId,
      items: [{ sku: 'TEST-A', quantity: 2 }, { sku: 'TEST-B', quantity: 4 }],
      correlationId
    });

    expect(result.outcome).toBe('REJECTED');
    expect(await stockOf('TEST-A')).toBe(10);
    expect(await stockOf('TEST-B')).toBe(3);
  });

  test('repeated SKUs in one order are added together', async () => {
    const result = await db.reserve({
      orderId: randomUUID(),
      items: [{ sku: 'TEST-A', quantity: 2 }, { sku: 'TEST-A', quantity: 3 }],
      correlationId
    });
    expect(result.outcome).toBe('RESERVED');
    expect(await stockOf('TEST-A')).toBe(5);
  });

  test('concurrent deliveries of the same order reserve stock exactly once', async () => {
    const orderId = randomUUID();
    const items = [{ sku: 'TEST-A', quantity: 4 }];
    const results = await Promise.all(
      Array.from({ length: 5 }, () => db.reserve({ orderId, items, correlationId }))
    );

    expect(results.filter((r) => r.duplicate === false).length).toBe(1);
    expect(results.every((r) => r.outcome === 'RESERVED')).toBe(true);
    expect(await stockOf('TEST-A')).toBe(6);
  });

  test('two different orders cannot oversell the last units', async () => {
    const results = await Promise.all([
      db.reserve({ orderId: randomUUID(), items: [{ sku: 'TEST-B', quantity: 2 }], correlationId }),
      db.reserve({ orderId: randomUUID(), items: [{ sku: 'TEST-B', quantity: 2 }], correlationId })
    ]);
    const reserved = results.filter((r) => r.outcome === 'RESERVED').length;
    expect(reserved).toBe(1);
    expect(await stockOf('TEST-B')).toBe(1);
  });

  test('mergeItems adds up repeated SKUs and sorts them', () => {
    expect(db.mergeItems([{ sku: 'B-2', quantity: 1 }, { sku: 'A-1', quantity: 2 }, { sku: 'B-2', quantity: 3 }])).toEqual([
      { sku: 'A-1', quantity: 2 },
      { sku: 'B-2', quantity: 4 }
    ]);
  });
});
