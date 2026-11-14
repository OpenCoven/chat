#!/usr/bin/env node
// Read-only App Store Connect metadata. No upload or tester-management endpoints.
import { createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
const BUNDLE = 'ai.opencoven.chat.companion';
const MAX_BODY = 1024 * 1024;
const MAX_WAIT = 15 * 60 * 1000;
const INTERNAL = new Set([
  'PROCESSING',
  'PROCESSING_EXCEPTION',
  'MISSING_EXPORT_COMPLIANCE',
  'READY_FOR_BETA_TESTING',
  'IN_BETA_TESTING',
  'EXPIRED',
  'IN_EXPORT_COMPLIANCE_REVIEW',
]);
const EXTERNAL = new Set([
  ...INTERNAL,
  'READY_FOR_BETA_SUBMISSION',
  'WAITING_FOR_BETA_REVIEW',
  'IN_BETA_REVIEW',
  'BETA_REJECTED',
  'BETA_APPROVED',
  'NOT_APPLICABLE',
]);

function requestURL(path) {
  if (
    typeof path !== 'string' ||
    path.length > 4096 ||
    !/^\/v1\/(apps|builds)(\?[^\r\n#]*)?$/.test(path)
  )
    throw Error('invalid_path');
  return new URL(path, ORIGIN);
}

export function signRequest({ keyId, issuer, privateKey }, path, now = Date.now()) {
  requestURL(path);
  if (
    typeof keyId !== 'string' ||
    typeof issuer !== 'string' ||
    !/^[A-Za-z0-9-]{1,100}$/.test(keyId) ||
    !/^[A-Za-z0-9-]{1,100}$/.test(issuer)
  )
    throw Error('invalid_credentials');
  const key =
    typeof privateKey === 'string' || Buffer.isBuffer(privateKey)
      ? createPrivateKey(privateKey)
      : privateKey;
  if (key?.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw Error('invalid_credentials');
  const iat = Math.floor(now / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuer, iat, exp: iat + 120, aud: 'appstoreconnect-v1', scope: [`GET ${path}`] })}`;
  return `${message}.${sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export function appleClient(
  credentials,
  { fetch = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {},
) {
  return async (path, budgetMs = 15000) => {
    const url = requestURL(path);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(timeoutMs, budgetMs, 15000)),
    );
    try {
      const response = await fetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${signRequest(credentials, path, now())}`,
          Accept: 'application/json',
        },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Error(`http_${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error('invalid_json');
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_BODY) throw Error('response_too_large');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw Error('invalid_json');
      }
    } catch (error) {
      // Never propagate transport, crypto or Apple response text: it can contain secrets.
      const code = /^(http_\d{3}|invalid_json|response_too_large)$/.test(error?.message)
        ? error.message
        : 'request_failed';
      throw Error(code);
    } finally {
      clearTimeout(timer);
    }
  };
}

function identity(resource, type, id) {
  return (
    resource?.type === type &&
    typeof resource.id === 'string' &&
    /^[A-Za-z0-9-]{1,100}$/.test(resource.id) &&
    (id === undefined || resource.id === id)
  );
}

export function inspectBuild(document, appId, target, now = Date.now()) {
  const fail = () => {
    throw Error('metadata_mismatch');
  };
  if (!Array.isArray(document?.data) || document.links?.next || document.data.length > 1) fail();
  if (document.data.length === 0) return { status: 'not_visible' };
  const build = document.data[0];
  if (
    !identity(build, 'builds') ||
    build.attributes?.version !== target.build ||
    !identity(build.relationships?.app?.data, 'apps', appId)
  )
    fail();
  function related(name, type) {
    const link = build.relationships?.[name]?.data;
    if (!identity(link, type) || !Array.isArray(document.included)) return fail();
    const found = document.included.filter((item) => item.type === type && item.id === link.id);
    if (found.length !== 1 || !found[0].attributes) return fail();
    return found[0].attributes;
  }
  if (related('app', 'apps').bundleId !== BUNDLE) fail();
  const version = related('preReleaseVersion', 'preReleaseVersions');
  if (version.version !== target.version || version.platform !== 'IOS') fail();
  const { processingState, expired, expirationDate } = build.attributes;
  const state = {
    processingState: ['PROCESSING', 'FAILED', 'INVALID', 'VALID'].includes(processingState)
      ? processingState
      : 'UNKNOWN',
  };
  if (state.processingState === 'UNKNOWN' || typeof expired !== 'boolean')
    return { ...state, status: 'unknown' };
  if (
    expired ||
    (expirationDate &&
      (!Number.isFinite(Date.parse(expirationDate)) || Date.parse(expirationDate) <= now))
  )
    return { ...state, status: 'rejected' };
  if (processingState === 'FAILED' || processingState === 'INVALID')
    return { ...state, status: 'rejected' };
  if (processingState === 'PROCESSING') return { ...state, status: 'processing' };
  const beta = related('buildBetaDetail', 'buildBetaDetails');
  const internalBuildState = INTERNAL.has(beta.internalBuildState)
    ? beta.internalBuildState
    : 'UNKNOWN';
  const externalBuildState = EXTERNAL.has(beta.externalBuildState)
    ? beta.externalBuildState
    : 'UNKNOWN';
  Object.assign(state, { internalBuildState, externalBuildState });
  if (internalBuildState === 'UNKNOWN' || externalBuildState === 'UNKNOWN')
    return { ...state, status: 'unknown' };
  const internalTesting = internalBuildState === 'IN_BETA_TESTING';
  const externalTesting = externalBuildState === 'IN_BETA_TESTING';
  const status =
    internalTesting || externalTesting
      ? 'testing_available'
      : internalBuildState === 'PROCESSING' || externalBuildState === 'PROCESSING'
        ? 'processing'
        : 'action_required';
  return { ...state, status, internalTesting, externalTesting };
}

export async function waitForBuild(client, target, { now = Date.now, sleep: pause = sleep } = {}) {
  if (
    !/^[1-9]\d{0,17}$/.test(target?.build) ||
    !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target?.version)
  )
    throw Error('invalid_target');
  const deadline = now() + MAX_WAIT;
  const query = (path, values) => `${path}?${new URLSearchParams(values)}`;
  const appPath = query('/v1/apps', {
    'filter[bundleId]': BUNDLE,
    'fields[apps]': 'bundleId',
    limit: '2',
  });
  let appId;
  const buildPath = () =>
    query('/v1/builds', {
      'filter[app]': appId,
      'filter[version]': target.build,
      'filter[preReleaseVersion.version]': target.version,
      'filter[preReleaseVersion.platform]': 'IOS',
      include: 'app,preReleaseVersion,buildBetaDetail',
      'fields[builds]':
        'version,processingState,expired,expirationDate,app,preReleaseVersion,buildBetaDetail',
      'fields[apps]': 'bundleId',
      'fields[preReleaseVersions]': 'version,platform',
      'fields[buildBetaDetails]': 'internalBuildState,externalBuildState',
      limit: '2',
    });
  let last = { status: 'not_visible' };
  const receipt = (state) => ({
    bundleId: BUNDLE,
    version: target.version,
    build: target.build,
    platform: 'IOS',
    checkedAt: new Date(now()).toISOString(),
    ...state,
    physicalInstallationVerified: false,
  });
  for (let attempt = 0; attempt < 60 && now() < deadline; attempt++) {
    try {
      if (!appId) {
        const apps = await client(appPath, Math.max(1, deadline - now()));
        if (
          !Array.isArray(apps?.data) ||
          apps.data.length !== 1 ||
          apps.links?.next ||
          !identity(apps.data[0], 'apps') ||
          apps.data[0].attributes?.bundleId !== BUNDLE
        )
          throw Error('app_mismatch');
        appId = apps.data[0].id;
      }
      last = inspectBuild(
        await client(buildPath(), Math.max(1, deadline - now())),
        appId,
        target,
        now(),
      );
    } catch (error) {
      if (error.message !== 'http_429') throw error;
      last = { status: 'rate_limited' };
    }
    if (!['not_visible', 'processing', 'rate_limited'].includes(last.status)) return receipt(last);
    if (attempt < 59 && now() < deadline) await pause(Math.min(15000, deadline - now()));
  }
  return receipt({ ...last, status: 'timed_out', lastStatus: last.status });
}

async function main() {
  const [build, version, receiptPath] = process.argv.slice(2);
  if (process.argv.length !== 5 || !receiptPath) throw Error('invalid_arguments');
  let receipt;
  try {
    const credentials = {
      keyId: process.env.APPLE_API_KEY,
      issuer: process.env.APPLE_API_ISSUER,
      privateKey: await readFile(process.env.APPLE_API_KEY_PATH),
    };
    receipt = await waitForBuild(appleClient(credentials), { build, version });
  } catch (error) {
    const allowed =
      /^(invalid_target|app_mismatch|metadata_mismatch|http_\d{3}|invalid_json|response_too_large|request_failed)$/;
    receipt = {
      status: 'verification_failed',
      error: allowed.test(error?.message) ? error.message : 'configuration_failed',
      physicalInstallationVerified: false,
    };
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.status === 'testing_available' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write(
      'TestFlight status verification failed; no availability is established.\n',
    );
    process.exitCode = 2;
  });
}
