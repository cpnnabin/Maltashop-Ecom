const { validateOrderRequest, isValidCorrelationId } = require('../src/validation');

describe('validateOrderRequest', () => {
  test('accepts a valid order', () => {
    const result = validateOrderRequest({ customerId: 'cust-001', productId: 'SKU-100', quantity: 2 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ customerId: 'cust-001', productId: 'SKU-100', quantity: 2 });
  });

  test('accepts a numeric string quantity and a numeric customerId', () => {
    const result = validateOrderRequest({ customerId: 42, productId: 'SKU-100', quantity: '3' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ customerId: '42', productId: 'SKU-100', quantity: 3 });
  });

  test('rejects a missing body', () => {
    expect(validateOrderRequest(undefined).ok).toBe(false);
    expect(validateOrderRequest(null).ok).toBe(false);
  });

  test('lists every missing field', () => {
    const result = validateOrderRequest({});
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(3);
  });

  test('rejects zero, negative, fractional, huge and non-numeric quantities', () => {
    for (const quantity of [0, -1, 1.5, 101, 'abc', '', null]) {
      expect(validateOrderRequest({ customerId: 'c', productId: 'SKU-100', quantity }).ok).toBe(false);
    }
  });

  test('rejects a product id that is too short or too long', () => {
    expect(validateOrderRequest({ customerId: 'c', productId: 'ab', quantity: 1 }).ok).toBe(false);
    expect(validateOrderRequest({ customerId: 'c', productId: 'x'.repeat(41), quantity: 1 }).ok).toBe(false);
  });

  test('rejects a blank customer id', () => {
    expect(validateOrderRequest({ customerId: '   ', productId: 'SKU-100', quantity: 1 }).ok).toBe(false);
  });
});

describe('isValidCorrelationId', () => {
  test('accepts ids of 8 to 100 safe characters', () => {
    expect(isValidCorrelationId('demo-corr-001')).toBe(true);
    expect(isValidCorrelationId('4f9c2d1e-0b5a-4c7e-9a31-2f6d8e7b1c3a')).toBe(true);
  });

  test('rejects short, long, unsafe or missing ids', () => {
    expect(isValidCorrelationId('short')).toBe(false);
    expect(isValidCorrelationId('x'.repeat(101))).toBe(false);
    expect(isValidCorrelationId('has spaces in it')).toBe(false);
    expect(isValidCorrelationId('line\nbreak-injection')).toBe(false);
    expect(isValidCorrelationId(undefined)).toBe(false);
  });
});
