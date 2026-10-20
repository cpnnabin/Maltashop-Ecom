const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://inventory:inventory@postgres-inventory:5432/inventory'
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock (
      product_id VARCHAR(64) PRIMARY KEY,
      available INT NOT NULL CHECK (available >= 0)
    );
  `);
  await pool.query(`
    INSERT INTO stock (product_id, available) VALUES
      ('SKU-100', 50),
      ('SKU-200', 5)
    ON CONFLICT (product_id) DO NOTHING;
  `);

  // One row per order: the decision (RESERVED or REJECTED) that was made for it.
  // The primary key on order_id is what makes duplicate OrderPlaced events harmless.
  const legacy = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'reservations' AND column_name = 'product_id'`
  );
  if (legacy.rowCount > 0) {
    throw new Error(
      "The 'reservations' table comes from an older version of this project. " +
      'Reset the database once with: docker compose down -v'
    );
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      order_id UUID PRIMARY KEY,
      status VARCHAR(16) NOT NULL CHECK (status IN ('RESERVED', 'REJECTED')),
      reason TEXT,
      correlation_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservation_items (
      order_id UUID NOT NULL REFERENCES reservations(order_id) ON DELETE CASCADE,
      product_id VARCHAR(64) NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (order_id, product_id)
    );
  `);
}

async function ping() {
  await pool.query('SELECT 1');
}

async function getStock(productId) {
  const res = await pool.query(`SELECT available FROM stock WHERE product_id = $1`, [productId]);
  return res.rows[0] ? res.rows[0].available : 0;
}

/** Adds up repeated SKUs and sorts them, so every order locks stock rows in the same order. */
function mergeItems(items) {
  const totals = new Map();
  for (const { sku, quantity } of items) {
    totals.set(sku, (totals.get(sku) || 0) + quantity);
  }
  return [...totals.entries()]
    .map(([sku, quantity]) => ({ sku, quantity }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

async function findReservation(orderId) {
  const res = await pool.query(`SELECT status, reason FROM reservations WHERE order_id = $1`, [orderId]);
  return res.rows[0];
}

/**
 * Decides an order exactly once, in ONE local database transaction (all items or none).
 *
 * Returns { outcome: 'RESERVED' | 'REJECTED', reason, duplicate }.
 *   - First time an order is seen: stock is reserved (RESERVED) or nothing changes (REJECTED),
 *     and the decision is recorded in `reservations`.
 *   - Same order again (duplicate or redelivered message): the recorded decision is returned and
 *     stock is NOT touched again. A rejected order stays rejected even if stock is replenished later.
 */
async function reserve({ orderId, items, correlationId }) {
  const wanted = mergeItems(items);
  const skus = wanted.map((w) => w.sku);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the stock rows first: concurrent deliveries of the same order queue up here.
    const stockRes = await client.query(
      `SELECT product_id, available FROM stock WHERE product_id = ANY($1::text[]) ORDER BY product_id FOR UPDATE`,
      [skus]
    );

    const existing = await client.query(`SELECT status, reason FROM reservations WHERE order_id = $1`, [orderId]);
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      return { outcome: existing.rows[0].status, reason: existing.rows[0].reason, duplicate: true };
    }

    const available = new Map(stockRes.rows.map((row) => [row.product_id, row.available]));
    const unknown = wanted.find((w) => !available.has(w.sku));
    const short = wanted.find((w) => available.has(w.sku) && available.get(w.sku) < w.quantity);

    if (unknown || short) {
      const reason = unknown ? `Unknown product ${unknown.sku}` : `Insufficient stock for ${short.sku}`;
      await client.query(
        `INSERT INTO reservations (order_id, status, reason, correlation_id) VALUES ($1, 'REJECTED', $2, $3)`,
        [orderId, reason, correlationId]
      );
      await client.query('COMMIT');
      return { outcome: 'REJECTED', reason, duplicate: false };
    }

    await client.query(
      `INSERT INTO reservations (order_id, status, correlation_id) VALUES ($1, 'RESERVED', $2)`,
      [orderId, correlationId]
    );
    for (const { sku, quantity } of wanted) {
      await client.query(`UPDATE stock SET available = available - $1 WHERE product_id = $2`, [quantity, sku]);
      await client.query(
        `INSERT INTO reservation_items (order_id, product_id, quantity) VALUES ($1, $2, $3)`,
        [orderId, sku, quantity]
      );
    }
    await client.query('COMMIT');
    return { outcome: 'RESERVED', reason: null, duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Two deliveries of an order for a product with no stock row can race on the primary key.
    if (err && err.code === '23505') {
      const existing = await findReservation(orderId);
      if (existing) return { outcome: existing.status, reason: existing.reason, duplicate: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = { init, ping, getStock, reserve, mergeItems, close, pool };
