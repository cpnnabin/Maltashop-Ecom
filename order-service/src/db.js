const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://order:order@postgres-order:5432/orders'
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      customer_id VARCHAR(64) NOT NULL,
      product_id VARCHAR(64) NOT NULL,
      quantity INT NOT NULL,
      status VARCHAR(32) NOT NULL,
      correlation_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Columns added later; safe to run on a database created by an older version.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);
  await pool.query(`ALTER TABLE orders ALTER COLUMN correlation_id TYPE VARCHAR(100);`);
}

async function ping() {
  await pool.query('SELECT 1');
}

async function createOrder({ id, customerId, productId, quantity, status, correlationId }) {
  await pool.query(
    `INSERT INTO orders (id, customer_id, product_id, quantity, status, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, customerId, productId, quantity, status, correlationId]
  );
}

async function updateOrderStatus(id, status) {
  await pool.query(`UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
}

/**
 * Moves an order out of PENDING exactly once (PENDING -> CONFIRMED or PENDING -> CANCELLED).
 * Returns true if this call changed the order, false if it was already decided or does not exist.
 * Because the check and the update are one statement, duplicate or conflicting events cannot
 * flip an order that has already been decided.
 */
async function transitionFromPending(id, status, reason = null) {
  const res = await pool.query(
    `UPDATE orders
        SET status = $2, cancel_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'`,
    [id, status, reason]
  );
  return res.rowCount === 1;
}

async function getOrder(id) {
  const res = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  return res.rows[0];
}

async function close() {
  await pool.end();
}

module.exports = { init, ping, createOrder, updateOrderStatus, transitionFromPending, getOrder, close, pool };
