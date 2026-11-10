// A stand-in for the paired iPhone (#542, #573). The lane turns the companion on
// through the window and reads the private pairing link from its text box, then
// talks to the companion's own HTTPS API as the iPhone app does: the link's bearer
// token, and the Mac's certificate checked against the link's fingerprint before a
// reply counts. It runs on the same runner as the app, so it proves what the Mac
// tells a paired phone, not what the iPhone app shows. A physical iPhone stays a
// hand row on #573.

import { randomUUID } from 'node:crypto';
import { request } from 'node:https';

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

export class Phone {
  constructor(link) {
    Object.assign(this, parsePairingLink(link));
  }

  /** Where the phone connects, for the record. The token is never recorded. */
  get address() {
    return this.endpoint.host;
  }

  call(method, path, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: this.endpoint.hostname,
          port: Number(this.endpoint.port || 443),
          path,
          method,
          agent: false,
          // The Mac's certificate is self-signed. It is pinned below, as the
          // phone pins it, and a reply from any other certificate is refused.
          rejectUnauthorized: false,
          timeout: 20_000,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
          },
        },
        (res) => {
          const seen = String(res.socket.getPeerCertificate?.()?.fingerprint256 ?? '')
            .replaceAll(':', '')
            .toLowerCase();
          if (seen !== this.fingerprint) {
            res.destroy();
            reject(new Error("the Mac's certificate does not match the pairing link"));
            return;
          }
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
