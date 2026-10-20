// Runs against a REAL PostgreSQL database. Skipped unless TEST_DATABASE_URL is set, for example:
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/test npm run test:db
// (The GitHub Actions workflow starts a PostgreSQL service and sets it.)
const { randomUUID } = require('node:crypto');

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('order database (real PostgreSQL)', () => {
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
    await db.pool.query('TRUNCATE orders');
  });

  async function newOrder(status = 'PENDING') {
    const id = randomUUID();
    await db.createOrder({ id, customerId: 'cust-1', productId: 'SKU-100', quantity: 2, status, correlationId: 'corr-12345' });
    return id;
  }

  test('init can run twice (migrations are idempotent)', async () => {
    await db.init();
    await db.init();
  });

  test('createOrder / getOrder round trip', async () => {
    const id = await newOrder();
    const order = await db.getOrder(id);
    expect(order).toMatchObject({ id, customer_id: 'cust-1', product_id: 'SKU-100', quantity: 2, status: 'PENDING', correlation_id: 'corr-12345' });
  });

  test('getOrder returns undefined for an unknown id', async () => {
    expect(await db.getOrder(randomUUID())).toBeUndefined();
  });

  test('a PENDING order can be CONFIRMED exactly once', async () => {
    const id = await newOrder();
    expect(await db.transitionFromPending(id, 'CONFIRMED')).toBe(true);
    expect(await db.transitionFromPending(id, 'CONFIRMED')).toBe(false);
    expect((await db.getOrder(id)).status).toBe('CONFIRMED');
  });

  test('a PENDING order can be CANCELLED with a reason', async () => {
    const id = await newOrder();
    expect(await db.transitionFromPending(id, 'CANCELLED', 'Insufficient stock for SKU-200')).toBe(true);
    const order = await db.getOrder(id);
    expect(order.status).toBe('CANCELLED');
    expect(order.cancel_reason).toBe('Insufficient stock for SKU-200');
  });

  test('a decided order can never be flipped by a late or conflicting event', async () => {
    const id = await newOrder();
    await db.transitionFromPending(id, 'CANCELLED', 'Insufficient stock for SKU-200');
    expect(await db.transitionFromPending(id, 'CONFIRMED')).toBe(false);
    expect((await db.getOrder(id)).status).toBe('CANCELLED');
  });

  test('transitioning an unknown order changes nothing', async () => {
    expect(await db.transitionFromPending(randomUUID(), 'CONFIRMED')).toBe(false);
  });
});
