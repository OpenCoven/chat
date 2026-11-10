// A stand-in for the paired iPhone (#542, #573). The lane turns the companion on
// through the window and reads the private pairing link from its text box, then
// talks to the companion's own HTTPS API as the iPhone app does: the link's bearer
// token, sent only to a server whose certificate has the link's fingerprint. It
// runs on the same runner as the app, so it proves what the Mac tells a paired
// phone, not what the iPhone app shows. A physical iPhone stays a hand row on #573.

import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';

/** The one name the companion's self-signed certificate carries (`credentials.rs`). */
export const COMPANION_NAME = 'coven-chat.local';

export function parsePairingLink(link) {
  const url = new URL(String(link).trim());
  if (url.protocol !== 'coven-chat:') throw new Error(`not a pairing link (${url.protocol})`);
  const endpoint = new URL(url.searchParams.get('endpoint') ?? '');
  const token = url.searchParams.get('token') ?? '';
  const fingerprint = (url.searchParams.get('fingerprint') ?? '').toLowerCase();
  if (endpoint.protocol !== 'https:') throw new Error('the pairing link has no HTTPS endpoint');
  if (token.length !== 64) throw new Error('the pairing link has no 64-character token');
  if (!/^[0-9a-f]{64}$/.test(fingerprint))
    throw new Error('the pairing link has no SHA-256 fingerprint');
  return { endpoint, token, fingerprint };
}

/**
 * Where the host keeps the companion's identity: `iphone-companion/identity.json`
 * under Tauri's local data folder for `ai.opencoven.chat`. The companion runs on
 * macOS and Linux only.
 */
export function companionIdentityPath(platform, home = homedir()) {
  const data =
    platform === 'mac'
      ? join(home, 'Library', 'Application Support')
      : join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'));
  return join(data, 'ai.opencoven.chat', 'iphone-companion', 'identity.json');
}

const digest = (der) => createHash('sha256').update(der).digest('hex');

/**
 * The companion's certificate, from the host's own files on this runner, once it
 * matches the link's fingerprint. A phone has no such file and pins the
 * fingerprint alone; the stand-in needs the certificate itself so that Node can
 * trust it as the only authority, and still checks the fingerprint in the
 * handshake. Nothing is sent to a server that fails either check.
 */
export function companionCertificate(identityPath, fingerprint) {
  const { certificate } = JSON.parse(readFileSync(identityPath, 'utf8'));
  const der = Buffer.from(certificate ?? []);
  if (digest(der) !== fingerprint)
    throw new Error("the Mac's certificate on disk does not match the pairing link");
  return new X509Certificate(der).toString();
}

export class Phone {
  /** `identity` is the host's identity.json; see companionIdentityPath. */
  constructor(link, { identity }) {
    Object.assign(this, parsePairingLink(link));
    this.ca = companionCertificate(identity, this.fingerprint);
  }

  /** Where the phone connects, for the record. The token is never recorded. */
  get address() {
    return this.endpoint.host;
  }

  call(method, path, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const pinned = this.fingerprint;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: this.endpoint.hostname,
          port: Number(this.endpoint.port || 443),
          path,
          method,
          agent: false,
          // The certificate is self-signed for one name, so it is the only
          // authority trusted, and its fingerprint is checked before the request,
          // and the token with it, leaves this process.
          ca: this.ca,
          servername: COMPANION_NAME,
          checkServerIdentity: (name, cert) =>
            checkServerIdentity(name, cert) ??
            (digest(cert.raw) === pinned
              ? undefined
              : new Error("the Mac's certificate does not match the pairing link")),
          timeout: 20_000,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode, json, text: text.slice(0, 500) });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`the Mac did not answer ${method} ${path}`)));
      req.on('error', reject);
      req.end(payload ?? undefined);
    });
  }

  snapshot() {
    return this.call('GET', '/v1/snapshot');
  }

  permissionLog() {
    return this.call('GET', '/v1/permission-log');
  }

  /** Answers a request as the phone does, each answer under a fresh request ID. */
  answer(approvalId, decision) {
    return this.call('POST', '/v1/approval', {
      requestId: randomUUID(),
      approvalId,
      decision,
    });
  }
}
