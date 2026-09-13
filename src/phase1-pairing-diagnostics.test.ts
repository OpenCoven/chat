import { expect, test } from 'vitest';
import {
  extractVerifiedRunnerDiagnostic,
  publicPhase1FailureDiagnostic,
} from '../scripts/phase1-conformance.mjs';
// @ts-expect-error Executable scripts have no declarations.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';

const { schemaV2FailureDiagnostic, schemaV2NativeFailureDiagnostic } = producer;

test.each([
  [
    'native RPC cave_pairing_create failed with secure_store_unavailable',
    'create.secure-store-unavailable',
  ],
  ['native RPC cave_pairing_exchange failed with keychain_failure', 'exchange.keychain-failure'],
  ['native RPC cave_pairing_poll failed with pairing_expired', 'poll.pairing-expired'],
  ['native RPC timed out for cave_pairing_create', 'create.timeout'],
  ['native RPC timed out for cave_pairing_poll', 'poll.timeout'],
  ['native RPC timed out for cave_pairing_exchange', 'exchange.timeout'],
  ['native RPC closed before responding', 'rpc-closed'],
  ['no native authority handle', 'authority-handle'],
  ['native pairing creation omitted its request ID', 'creation-response'],
  ['native pairing did not begin pending', 'pending-status'],
  ['native pairing was not approved', 'approved-status'],
  ['native pairing exchange returned an unsafe result', 'exchange-response'],
  ['Cave admin mutation failed with HTTP 403', 'admin-http-4xx'],
  ['Cave admin mutation failed with HTTP 503', 'admin-http-5xx'],
  ['Cave admin mutation failed with HTTP 302', 'admin-http-3xx'],
  ['native RPC cave_pairing_create failed with private-secret', 'unknown'],
  ['native RPC cave_pairing_exchange failed with keychain_failure private-secret', 'unknown'],
  ['Cave admin mutation failed with HTTP 403 private-secret', 'unknown'],
  ['private-secret', 'unknown'],
])('bounds pairing failure %s', (message, category) => {
  const diagnostic = `phase1.native-scenarios.pairing.${category}`;
  expect(schemaV2NativeFailureDiagnostic('pairing', new Error(message))).toBe(diagnostic);
  expect(publicPhase1FailureDiagnostic(new Error(diagnostic))).toBe(diagnostic);
  expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
});

test('preserves the generic pairing stage without an error', () => {
  expect(schemaV2NativeFailureDiagnostic('pairing')).toBe('phase1.native-scenarios.pairing');
});

const nativeCodes = [
  'invalid_request',
  'unauthorized',
  'scope_denied',
  'not_found',
  'conflict',
  'rate_limited',
  'pairing_denied',
  'pairing_expired',
  'incompatible_version',
  'service_unavailable',
  'reconcile_required',
  'internal_error',
  'invalid_response',
  'timeout',
  'stale_discovery_handle',
  'invalid_native_response',
  'invalid_native_input',
  'secure_store_unavailable',
  'keychain_failure',
];
test.each(
  ['create', 'poll', 'exchange'].flatMap((operation) =>
    nativeCodes.map((code) => [operation, code]),
  ),
)('propagates pairing %s/%s through both diagnostic boundaries', (operation, code) => {
  const diagnostic = `phase1.native-scenarios.pairing.${operation}.${code.replaceAll('_', '-')}`;
  const classified = schemaV2NativeFailureDiagnostic(
    'pairing',
    new Error(`native RPC cave_pairing_${operation} failed with ${code}`),
  );
  expect(classified).toBe(diagnostic);
  expect(
    schemaV2FailureDiagnostic(new Error(classified), 'phase1.stage.native-scenarios.failed'),
  ).toBe(diagnostic);
  expect(publicPhase1FailureDiagnostic(new Error(classified))).toBe(diagnostic);
  expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${classified}`)).toBe(diagnostic);
});
