import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

// The native lane's asking-for-permission pieces (#573): which rows a run drives,
// the candidate-only switch, the fixture's approval script, and the phone stand-in.
const approvalPath = '../scripts/native-acceptance/approval.mjs';
const fixturePath = '../scripts/native-acceptance/fixture.mjs';
const phonePath = '../scripts/native-acceptance/phone.mjs';
const { askingRowsFor } = await import(approvalPath);
const { startModelFixture, MOVED_ON } = await import(fixturePath);
const { Phone, parsePairingLink } = await import(phonePath);

const OFF = 'pub const X: u8 = 1;\nconst ASKING_ENABLED: bool = false;\n';
const ON = OFF.replace('false;', 'true;');
const scratch = mkdtempSync(join(tmpdir(), 'native-asking-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('which asking rows a native run drives', () => {
  test('as built, the build decides', () => {
    expect(askingRowsFor({ source: OFF }).rows).toBe('asking-off');
    expect(askingRowsFor({ source: ON }).rows).toBe('asking');
    expect(askingRowsFor({ source: OFF, tag: 'v0.0.9' })).toMatchObject({
      rows: 'asking-off',
      built: 'false',
      from: 'src-tauri/src/chat_approvals.rs at tag v0.0.9',
    });
  });

  test('rows-on-as-built drives the asking rows on a build that has asking off', () => {
    expect(askingRowsFor({ mode: 'rows-on-as-built', source: OFF })).toMatchObject({
      rows: 'asking',
      built: 'false',
    });
  });

  test('switched-on needs a candidate whose source really is switched on', () => {
    expect(askingRowsFor({ mode: 'switched-on', source: ON }).rows).toBe('asking');
    expect(askingRowsFor({ mode: 'switched-on', source: OFF })).toMatchObject({
      rows: 'none',
      built: 'false',
    });
    expect(askingRowsFor({ mode: 'switched-on', source: ON, tag: 'v0.0.9' })).toMatchObject({
      rows: 'none',
      reason: expect.stringContaining('not a published release'),
    });
  });

  test('a build that cannot be read runs nothing it would have to guess about', () => {
    expect(askingRowsFor({ source: 'no switch here' }).rows).toBe('none');
    expect(askingRowsFor({ error: 'tag not found' })).toMatchObject({
      rows: 'none',
      reason: 'tag not found',
    });
    expect(askingRowsFor({ mode: 'sideways', source: ON }).rows).toBe('none');
  });
});

describe('switching asking on for a candidate', () => {
  const script = join(process.cwd(), 'scripts/native-acceptance/switch-asking.mjs');
  const DECLINE = '      onDeclineApproval={(approval) => void declineApproval(approval)}\n';
  const LOG = '      onPermissionLog={() => runtime.permissionLog()}\n';
  const WINDOW = `    <ChatLayout\n${DECLINE}      archivedFilter={archived}\n`;
  const run = (host: string, window: string) =>
    spawnSync(process.execPath, [script, host, window], { encoding: 'utf8' });
  const files = (name: string, host: string, window: string) => {
    const paths = [join(scratch, `${name}.rs`), join(scratch, `${name}.tsx`)] as const;
    writeFileSync(paths[0], host);
    writeFileSync(paths[1], window);
    return paths;
  };

  test("undoes #562's two switches, and leaves an already switched-on checkout alone", () => {
    const [host, window] = files('off', OFF, WINDOW);
    expect(run(host, window).status).toBe(0);
    expect(readFileSync(host, 'utf8')).toBe(ON);
    expect(readFileSync(window, 'utf8')).toBe(WINDOW.replace(DECLINE, DECLINE + LOG));
    const again = run(host, window);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already on');
    expect(again.stdout).toContain('already passed');
    expect(readFileSync(host, 'utf8')).toBe(ON);
    expect(readFileSync(window, 'utf8')).toBe(WINDOW.replace(DECLINE, DECLINE + LOG));
  });

  test('refuses a checkout it does not recognise, and changes neither file', () => {
    const [host, window] = files('two', OFF + OFF, WINDOW);
    expect(run(host, window).status).toBe(1);
    expect(readFileSync(host, 'utf8')).toBe(OFF + OFF);
    expect(readFileSync(window, 'utf8')).toBe(WINDOW);
    const [host2, window2] = files('moved', OFF, '<ChatLayout />\n');
    expect(run(host2, window2).status).toBe(1);
    expect(readFileSync(host2, 'utf8')).toBe(OFF);
  });

  test("matches this checkout's window, so a candidate run can't silently skip it", () => {
    const source = readFileSync(join(process.cwd(), 'src/coven/chat-app.tsx'), 'utf8');
    expect(source.split(DECLINE).length - 1).toBe(1);
    expect(source).not.toContain(LOG);
  });
});

describe("the native fixture's approval script", () => {
  test('asks the engine to write, then answers what the engine did, and logs each step', async () => {
    const log = join(scratch, 'model.jsonl');
    writeFileSync(log, '');
    const fixture = await startModelFixture({ log });
    try {
      const post = (body: object) =>
        fetch(`http://127.0.0.1:${fixture.port}/v1/messages`, {
          method: 'POST',
          body: JSON.stringify(body),
        }).then((response) => response.text());
      const ask = {
        role: 'user',
        content: 'note: coven-permission-request\n[[ask /tmp/proof.txt]] Write the proof file.',
      };
      const write = await post({ stream: true, model: 'm', messages: [ask] });
      expect(write).toContain('"type":"tool_use"');
      expect(write).toContain('"name":"Write"');
      expect(write).toContain('/tmp/proof.txt');
      expect(write).toContain('"stop_reason":"tool_use"');

      const refused = await post({
        stream: false,
        model: 'm',
        messages: [
          ask,
          { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Write', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'no' }],
          },
        ],
      });
      expect(refused).toContain('coven-permission-request');

      const spaced = await post({
        stream: true,
        model: 'm',
        messages: [{ role: 'user', content: '[[ask /Users/r/Application Support/p.txt]] Write.' }],
      });
      expect(spaced).toContain('/Users/r/Application Support/p.txt');

      // Chat replays earlier turns ahead of each message: this message's own
      // token wins over a replayed [[ask]], and an allowed turn, whose own words
      // carry none, still reaches the request it answers.
      const replay = (latest: string) =>
        `[Coven Chat replay]\nEarlier turns:\nUser: [[slow]] Take your time.\n\nUser: [[ask /tmp/old.txt]] Write the proof file.\n\nLatest message:\n${latest}`;
      const replayedMove = await post({
        stream: true,
        model: 'm',
        messages: [{ role: 'user', content: replay('[[moveon]] Never mind.') }],
      });
      expect(replayedMove).toContain(`## ${MOVED_ON}`);
      expect(replayedMove).not.toContain('tool_use');
      const allowedTurn = await post({
        stream: true,
        model: 'm',
        messages: [
          {
            role: 'user',
            content: `This turn has write access. ${replay('Go ahead: Write the proof file.')}`,
          },
        ],
      });
      expect(allowedTurn).toContain('/tmp/old.txt');

      const moved = await post({
        stream: true,
        model: 'm',
        messages: [{ role: 'user', content: '[[moveon]] Never mind.' }],
      });
      expect(moved).toContain(`## ${MOVED_ON}`);

      const entries = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(entries.map((entry) => [entry.token, entry.step])).toEqual([
        ['ask', 'write'],
        ['ask', 'text'],
        ['ask', 'write'],
        ['moveon', undefined],
        ['ask', 'write'],
        ['moveon', undefined],
      ]);
    } finally {
      await fixture.close();
    }
  });
});

describe('the phone stand-in', () => {
  const hex = (byte: string) => byte.repeat(64);

  test('reads a pairing link and refuses one that lacks what a phone needs', () => {
    const endpoint = encodeURIComponent('https://10.0.0.5:47321');
    const link = `coven-chat://pair?endpoint=${endpoint}&token=${hex('a')}&fingerprint=${hex('B')}`;
    const parsed = parsePairingLink(link);
    expect(parsed.endpoint.host).toBe('10.0.0.5:47321');
    expect(parsed.fingerprint).toBe(hex('b'));
    expect(() => parsePairingLink(link.replace('coven-chat:', 'https:'))).toThrow(
      'not a pairing link',
    );
    expect(() => parsePairingLink(link.replace(hex('a'), 'short'))).toThrow('64-character token');
    expect(() => parsePairingLink(link.replace(hex('B'), 'zz'))).toThrow('fingerprint');
    expect(() => parsePairingLink(link.replace(endpoint, 'http%3A%2F%2F10.0.0.5'))).toThrow(
      'HTTPS endpoint',
    );
  });

  const openssl = spawnSync('openssl', ['version']).status === 0;
  test.skipIf(!openssl)(
    "pins the Mac's certificate and sends what the companion's parser accepts",
    async () => {
      const key = join(scratch, 'key.pem');
      const cert = join(scratch, 'cert.pem');
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=companion-test',
      ]);
      const pem = readFileSync(cert, 'utf8');
      const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
      const fingerprint = createHash('sha256').update(der).digest('hex');
      const seen: { method: string; headers: IncomingHttpHeaders; body: string }[] = [];
      const server = createServer({ key: readFileSync(key), cert: pem }, (req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          seen.push({ method: req.method ?? '', headers: req.headers, body });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ pendingApprovals: [] }));
        });
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
      const { port } = server.address() as AddressInfo;
      const link = (print: string) =>
        `coven-chat://pair?endpoint=${encodeURIComponent(`https://127.0.0.1:${port}`)}&token=${hex('c')}&fingerprint=${print}`;
      try {
        const phone = new Phone(link(fingerprint));
        const read = await phone.snapshot();
        expect(read).toMatchObject({ status: 200, json: { pendingApprovals: [] } });
        const answer = await phone.answer('approval-1', 'decline');
        expect(answer.status).toBe(200);
        const [get, post] = seen;
        if (!get || !post) throw new Error(`the server saw ${seen.length} requests`);
        expect(get).toMatchObject({ method: 'GET', body: '' });
        expect(get.headers.authorization).toBe(`Bearer ${hex('c')}`);
        expect(get.headers.origin).toBeUndefined();
        expect(post.method).toBe('POST');
        expect(post.headers['content-type']).toBe('application/json');
        expect(post.headers['transfer-encoding']).toBeUndefined();
        expect(Number(post.headers['content-length'])).toBe(Buffer.byteLength(post.body));
        expect(JSON.parse(post.body)).toMatchObject({
          approvalId: 'approval-1',
          decision: 'decline',
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });

        await expect(new Phone(link(hex('d'))).snapshot()).rejects.toThrow(
          "the Mac's certificate does not match the pairing link",
        );
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );
});
