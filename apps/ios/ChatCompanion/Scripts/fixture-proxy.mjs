// Fault injection for the native UI tests. Never packaged with the application.
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';

const original = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const identity = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const upstream = new URL(original.endpoint);
const pairing = new URL(original.pairingLink);
const token = pairing.searchParams.get('token');
const fingerprint = pairing.searchParams.get('fingerprint');
const certificate = new X509Certificate(Buffer.from(identity.certificate));
if (createHash('sha256').update(certificate.raw).digest('hex') !== fingerprint) {
  throw new Error('Fixture identity mismatch.');
}
// A distinct pin prevents Bonjour from finding the upstream fixture and bypassing faults.
const identityDirectory = mkdtempSync(join(dirname(process.argv[2]), '.proxy-identity-'));
let key;
let proxyCertificate;
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=coven-chat-fixture-proxy',
      '-keyout',
      join(identityDirectory, 'key.pem'),
      '-out',
      join(identityDirectory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  key = readFileSync(join(identityDirectory, 'key.pem'));
  proxyCertificate = new X509Certificate(readFileSync(join(identityDirectory, 'cert.pem')));
} finally {
  rmSync(identityDirectory, { recursive: true, force: true });
}
const stats = { sendCount: 0, lastRequestID: null, receiptIDs: [] };
let offline = false;
let dropNextSend = false;
let offlineAfterDrop = false;
let headChanged = false;

function authorized(header) {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('Fixture request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function forward(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      upstream,
      {
        method,
        path,
        headers: { ...headers, host: upstream.host, 'content-length': body.length },
        ca: certificate.toString(),
        minVersion: 'TLSv1.3',
        servername: 'coven-chat.local',
        checkServerIdentity: (_host, peer) => {
          if (!peer.raw || createHash('sha256').update(peer.raw).digest('hex') !== fingerprint) {
            return new Error('Fixture upstream identity mismatch.');
          }
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) response.destroy(new Error('Fixture response too large.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.setTimeout(15000, () => request.destroy(new Error('Fixture upstream timeout.')));
    request.on('error', reject);
    request.end(body);
  });
}
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
async function stopActive() {
  const reply = await forward('GET', '/v1/snapshot', Buffer.alloc(0), auth);
  const run = JSON.parse(reply.body).activeRun;
  if (run?.id)
    await forward('POST', '/v1/stop', Buffer.from(JSON.stringify({ runId: run.id })), auth);
}
function json(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': bytes.length,
  });
  response.end(bytes);
}
const server = https.createServer(
  { key, cert: proxyCertificate.toString(), minVersion: 'TLSv1.3' },
  async (request, response) => {
    try {
      const body = await bodyOf(request);
      const path = new URL(request.url, 'https://fixture.invalid');
      if (path.pathname === '/__fixture/control') {
        if (!authorized(request.headers.authorization))
          return json(response, 401, { error: 'Unauthorized fixture control.' });
        if (request.method === 'POST') {
          const change = JSON.parse(body);
          if (change.reset) {
            await stopActive();
            stats.sendCount = 0;
            stats.lastRequestID = null;
            stats.receiptIDs = [];
            dropNextSend = false;
            offlineAfterDrop = false;
            headChanged = false;
          }
          if (change.stopActive) await stopActive();
          if ('offline' in change) offline = change.offline === true;
          if ('dropNextSend' in change) dropNextSend = change.dropNextSend === true;
          if ('offlineAfterDrop' in change) offlineAfterDrop = change.offlineAfterDrop === true;
          if ('headChanged' in change) headChanged = change.headChanged === true;
        } else if (request.method !== 'GET') return json(response, 405, {});
        return json(response, 200, stats);
      }
      if (offline) return response.destroy();
      let drop = false;
      if (request.method === 'POST' && path.pathname === '/v1/send') {
        stats.sendCount += 1;
        stats.lastRequestID = JSON.parse(body).requestId;
        drop = dropNextSend;
        dropNextSend = false;
      }
      if (path.pathname === '/v1/run') {
        stats.receiptIDs = [...stats.receiptIDs.slice(-19), path.searchParams.get('id')];
      }
      const reply = await forward(request.method, request.url, body, request.headers);
      if (drop && reply.status === 200) {
        offline = offlineAfterDrop;
        return response.destroy(); // Host admission happened; the phone never receives its receipt.
      }
      if (headChanged && reply.status === 200) {
        if (path.pathname === '/v1/history') {
          const value = JSON.parse(reply.body);
          value.sessionId = 'fixture-head-2';
          return json(response, 200, value);
        }
        if (path.pathname === '/v1/snapshot') {
          const value = JSON.parse(reply.body);
          value.sessions = [
            { id: 'fixture-head-2', familiarId: 'fixture', title: 'Fixture', archived: false },
          ];
          return json(response, 200, value);
        }
      }
      response.writeHead(reply.status, {
        'content-type': 'application/json',
        'content-length': reply.body.length,
      });
      response.end(reply.body);
    } catch {
      if (!response.destroyed && !response.headersSent)
        json(response, 503, { error: 'Fixture unavailable.' });
      else response.destroy();
    }
  },
);
server.maxHeadersCount = 32;
server.requestTimeout = 20000;
server.listen(0, upstream.hostname, () => {
  const endpoint = new URL(upstream);
  endpoint.port = String(server.address().port);
  pairing.searchParams.set('endpoint', endpoint.toString().replace(/\/$/, ''));
  pairing.searchParams.set(
    'fingerprint',
    createHash('sha256').update(proxyCertificate.raw).digest('hex'),
  );
  process.stdout.write(
    `${JSON.stringify({ ...original, endpoint: endpoint.toString().replace(/\/$/, ''), pairingLink: pairing.toString(), fixtureProxy: 'enabled' })}\n`,
  );
});
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close();
});
