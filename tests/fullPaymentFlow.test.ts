/**
 * Full Payment Lifecycle Integration Test
 *
 * Run with: npx ts-node tests/fullPaymentFlow.test.ts
 *
 * This test walks through the complete payment flow:
 * 1. Initiate
 * 2. Authenticate (OTP)
 * 3. Process
 * 4. Reconcile
 * 5. Idempotency verification
 * 6. Retry on failure
 * 7. Audit trail
 */

import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = 'http://localhost:3000';
const MERCHANT_ID = 'merchant_test_001';

const client: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true,  // Don't throw on non-2xx
});

// ── Helpers ───────────────────────────────────────────────────

const log = (msg: string, data?: unknown) => {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`  ✗ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
};

// ── Tests ─────────────────────────────────────────────────────

async function testHealthCheck(): Promise<void> {
  log('TEST 1: Health Check');
  const res = await client.get('/health');
  assert(res.status === 200, 'Health check returns 200');
  assert(res.data.status === 'healthy', 'Services are healthy');
}

async function testFullHappyPath(): Promise<void> {
  log('TEST 2: Full Happy Path — Initiate → Authenticate → Process → Reconcile');

  const idempotencyKey = `idem_${uuidv4()}`;

  // ── Step 1: Initiate ─────────────────────────────────────────
  log('  Step 1: Initiate payment');
  const initiateRes = await client.post(
    '/api/payments/initiate',
    {
      amount:      500.00,
      currency:    'INR',
      payerUpiId:  'aditi@okaxis',
      payeeUpiId:  'merchant@hdfc',
      merchantId:  MERCHANT_ID,
      description: 'Test payment',
    },
    { headers: { 'Idempotency-Key': idempotencyKey } }
  );

  assert(initiateRes.status === 201, 'Initiate returns 201');
  assert(initiateRes.data.status === 'INITIATED', 'Status is INITIATED');
  assert(!!initiateRes.data.transactionId, 'Has transaction ID');
  assert(!!initiateRes.data.simulatedOtp, 'Has simulated OTP');

  const { transactionId, simulatedOtp } = initiateRes.data;
  log('  Initiated:', { transactionId, status: initiateRes.data.status, otp: simulatedOtp });

  // ── Step 2: Idempotency Check ─────────────────────────────────
  log('  Step 2: Retry same request — must return same response (idempotency)');
  const retryInitiate = await client.post(
    '/api/payments/initiate',
    { amount: 500.00, currency: 'INR', payerUpiId: 'aditi@okaxis', payeeUpiId: 'merchant@hdfc', merchantId: MERCHANT_ID },
    { headers: { 'Idempotency-Key': idempotencyKey } }
  );

  assert(retryInitiate.status === 201, 'Idempotent retry returns 201');
  assert(retryInitiate.data.transactionId === transactionId, 'Returns same transaction ID');
  assert(retryInitiate.headers['x-idempotency-replayed'] === 'true', 'Has X-Idempotency-Replayed header');
  log('  ✓ Idempotency verified — same response, header present');

  // ── Step 3: Authenticate ──────────────────────────────────────
  log('  Step 3: Authenticate with OTP');
  const authRes = await client.post(`/api/payments/${transactionId}/authenticate`, {
    otp: simulatedOtp,
  });

  assert(authRes.status === 200, 'Authenticate returns 200');
  assert(authRes.data.status === 'AUTHENTICATED', 'Status is AUTHENTICATED');
  log('  Authenticated:', { status: authRes.data.status });

  // ── Step 4: Wrong OTP should fail ─────────────────────────────
  // OTP already consumed, so retry with correct OTP should also fail
  log('  Step 4: Re-use OTP — should fail (OTP consumed)');
  const badAuthRes = await client.post(`/api/payments/${transactionId}/authenticate`, {
    otp: simulatedOtp,
  });
  // Will be 422 because transaction is now AUTHENTICATED, can't re-authenticate
  assert(badAuthRes.status >= 400, 'Re-authentication is rejected');
  log('  ✓ OTP replay correctly rejected');

  // ── Step 5: Process ───────────────────────────────────────────
  log('  Step 5: Process payment');
  const processRes = await client.post(`/api/payments/${transactionId}/process`);

  assert(processRes.status === 200, 'Process returns 200');
  assert(
    ['SUCCESS', 'FAILED'].includes(processRes.data.status),
    'Status is SUCCESS or FAILED (random simulation)'
  );
  log('  Processed:', {
    status:          processRes.data.status,
    bankReferenceId: processRes.data.bankReferenceId,
    failureReason:   processRes.data.failureReason,
  });

  // ── Step 6: Reconcile (if SUCCESS) ───────────────────────────
  if (processRes.data.status === 'SUCCESS') {
    log('  Step 6: Reconcile transaction');
    const reconcileRes = await client.post(`/api/payments/${transactionId}/reconcile`);

    assert(reconcileRes.status === 200, 'Reconcile returns 200');
    assert(reconcileRes.data.status === 'RECONCILED', 'Status is RECONCILED');
    log('  Reconciled:', { status: reconcileRes.data.status, reconciledAt: reconcileRes.data.reconciledAt });

    // Terminal state — try to reconcile again, must fail
    const reReconcile = await client.post(`/api/payments/${transactionId}/reconcile`);
    assert(reReconcile.status === 422, 'Re-reconcile of terminal state returns 422');
    log('  ✓ Terminal state correctly enforced');
  }

  // ── Step 7: Get status ────────────────────────────────────────
  log('  Step 7: Get final transaction status');
  const statusRes = await client.get(`/api/payments/${transactionId}`);
  assert(statusRes.status === 200, 'Status check returns 200');
  log('  Final state:', {
    status:          statusRes.data.status,
    retryCount:      statusRes.data.retryCount,
    bankReferenceId: statusRes.data.bankReferenceId,
  });

  // ── Step 8: Audit Trail ───────────────────────────────────────
  log('  Step 8: Check audit trail');
  const auditRes = await client.get(`/api/payments/${transactionId}/audit`);
  assert(auditRes.status === 200, 'Audit trail returns 200');
  assert(Array.isArray(auditRes.data.auditLog), 'Audit log is an array');
  assert(auditRes.data.auditLog.length >= 1, 'Has audit entries');
  log('  Audit trail:', auditRes.data.auditLog);
}

async function testRetryFlow(): Promise<void> {
  log('TEST 3: Retry Flow — Force failure, then retry');

  // We'll initiate a new payment and force the retry path
  // by repeatedly processing until we get a FAILED result
  // (In production: set PAYMENT_SUCCESS_RATE=0 in .env to force failures)

  const idempotencyKey = `retry_test_${uuidv4()}`;
  const initRes = await client.post(
    '/api/payments/initiate',
    { amount: 100.00, payerUpiId: 'test@upi', payeeUpiId: 'merchant@upi', merchantId: MERCHANT_ID },
    { headers: { 'Idempotency-Key': idempotencyKey } }
  );

  assert(initRes.status === 201, 'Initiate for retry test succeeded');
  const { transactionId, simulatedOtp } = initRes.data;

  // Authenticate
  await client.post(`/api/payments/${transactionId}/authenticate`, { otp: simulatedOtp });

  // Process (may succeed or fail depending on simulation rate)
  const processRes = await client.post(`/api/payments/${transactionId}/process`);

  if (processRes.data.status === 'FAILED') {
    log('  Payment failed — testing retry');

    const retryRes = await client.post(`/api/payments/${transactionId}/retry`);
    assert(retryRes.status === 200, 'Retry returns 200');
    assert(retryRes.data.status === 'INITIATED', 'Retry resets to INITIATED');
    assert(retryRes.data.retryCount === 1, 'Retry count incremented to 1');
    assert(!!retryRes.data.simulatedOtp, 'New OTP generated for retry');
    log('  Retry result:', {
      status:     retryRes.data.status,
      retryCount: retryRes.data.retryCount,
      newOtp:     retryRes.data.simulatedOtp,
    });
  } else {
    log('  Payment succeeded (no failure to retry). Set PAYMENT_SUCCESS_RATE=0 to force failures.');
  }
}

async function testInvalidTransitions(): Promise<void> {
  log('TEST 4: Invalid State Transitions — Must all be rejected');

  const idempotencyKey = `invalid_test_${uuidv4()}`;
  const initRes = await client.post(
    '/api/payments/initiate',
    { amount: 50.00, payerUpiId: 'test@upi', payeeUpiId: 'merchant@upi', merchantId: MERCHANT_ID },
    { headers: { 'Idempotency-Key': idempotencyKey } }
  );

  const { transactionId } = initRes.data;

  // Try to process without authenticating first
  log('  Attempt: INITIATED -> PROCESSING (skipping AUTHENTICATED)');
  const skipAuthRes = await client.post(`/api/payments/${transactionId}/process`);
  assert(skipAuthRes.status === 422, 'INITIATED -> PROCESSING is rejected (422)');
  assert(skipAuthRes.data.code === 'INVALID_TRANSITION', 'Error code is INVALID_TRANSITION');
  log('  ✓ Invalid transition correctly blocked:', skipAuthRes.data);

  // Try to reconcile an INITIATED transaction
  log('  Attempt: INITIATED -> RECONCILED (invalid jump)');
  const skipToReconcile = await client.post(`/api/payments/${transactionId}/reconcile`);
  assert(skipToReconcile.status === 422, 'INITIATED -> RECONCILED is rejected');
  log('  ✓ Invalid reconcile correctly blocked');
}

async function testWebhookRegistration(): Promise<void> {
  log('TEST 5: Webhook Registration');

  const registerRes = await client.post('/api/webhooks/register', {
    merchantId: MERCHANT_ID,
    url:        `${BASE_URL}/api/webhooks/test/receive`,
    events:     ['PAYMENT_SUCCESS', 'PAYMENT_FAILED'],
  });

  assert(registerRes.status === 201, 'Webhook registration returns 201');
  assert(!!registerRes.data.webhookId, 'Has webhook ID');
  assert(!!registerRes.data.secret, 'Has signing secret');
  log('  Webhook registered:', {
    webhookId: registerRes.data.webhookId,
    url:       registerRes.data.url,
    events:    registerRes.data.events,
  });

  // List webhooks
  const listRes = await client.get(`/api/webhooks/merchant/${MERCHANT_ID}`);
  assert(listRes.status === 200, 'List webhooks returns 200');
  assert(listRes.data.webhooks.length >= 1, 'Has at least one webhook');
  assert(!listRes.data.webhooks[0].secret, 'Secret not exposed in list response');
  log('  ✓ Secret not exposed in list response');
}

async function testMissingIdempotencyKey(): Promise<void> {
  log('TEST 6: Missing Idempotency-Key — Must return 400');

  const res = await client.post('/api/payments/initiate', {
    amount:     100.00,
    payerUpiId: 'test@upi',
    payeeUpiId: 'merchant@upi',
    merchantId: MERCHANT_ID,
  });
  // No Idempotency-Key header

  assert(res.status === 400, 'Missing idempotency key returns 400');
  assert(res.data.code === 'MISSING_IDEMPOTENCY_KEY', 'Correct error code');
  log('  ✓ Missing idempotency key correctly rejected');
}

// ── Test Runner ───────────────────────────────────────────────

async function runAll(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     UPI Gateway — Full Integration Test Suite             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\nMake sure the server is running: npm run dev\n');

  try {
    await testHealthCheck();
    await testFullHappyPath();
    await testRetryFlow();
    await testInvalidTransitions();
    await testWebhookRegistration();
    await testMissingIdempotencyKey();

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  ✅  ALL TESTS PASSED                                     ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
  } catch (error) {
    console.error('\n✗ Test suite failed:', error);
    process.exit(1);
  }
}

runAll();
