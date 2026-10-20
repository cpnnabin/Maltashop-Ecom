/**
 * Request validation for POST /orders.
 * The limits match contracts/order-placed.schema.json so every accepted order
 * produces a valid OrderPlaced event.
 */
function validateOrderRequest(body) {
  const errors = [];
  const input = body && typeof body === 'object' ? body : {};

  const customerId = typeof input.customerId === 'number' ? String(input.customerId) : input.customerId;
  if (typeof customerId !== 'string' || customerId.trim().length < 1 || customerId.length > 100) {
    errors.push('customerId is required (1-100 characters)');
  }

  const productId = input.productId;
  if (typeof productId !== 'string' || productId.length < 3 || productId.length > 40) {
    errors.push('productId is required (3-40 characters)');
  }

  const quantity = typeof input.quantity === 'string' && input.quantity.trim() !== '' ? Number(input.quantity) : input.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    errors.push('quantity must be a whole number from 1 to 100');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { customerId: customerId.trim(), productId, quantity } };
}

/** Accepts a client-supplied correlation ID only if it is safe to log and fits the event schema. */
function isValidCorrelationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,100}$/.test(value);
}

module.exports = { validateOrderRequest, isValidCorrelationId };
