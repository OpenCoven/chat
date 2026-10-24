// What differs between the Linux and Windows lanes: reading the system
// clipboard, and registering a recorder as the default web browser.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDER = join(dirname(fileURLToPath(import.meta.url)), 'record-url.mjs');

/** The system clipboard's text, read by a separate process, never by the page. */
export function readClipboard() {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))',
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    return out;
  }
  try {
    return execFileSync('xclip', ['-o', '-selection', 'clipboard'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // xclip exits 1 when nothing owns the clipboard yet.
    if (error.status === 1) return '';
    throw error;
  }
}

function registerLinux(log) {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const name = 'chat-acceptance-browser.desktop';
  mkdirSync(join(data, 'applications'), { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(data, 'applications', name),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Chat acceptance browser',
      `Exec="${process.execPath}" "${RECORDER}" "${log}" %u`,
      'MimeType=x-scheme-handler/http;x-scheme-handler/https;',
      'NoDisplay=true',
      '',
    ].join('\n'),
  );
  const list = join(config, 'mimeapps.list');
  writeFileSync(
    list,
    [
      '[Default Applications]',
      `x-scheme-handler/http=${name}`,
      `x-scheme-handler/https=${name}`,
      '',
    ].join('\n'),
  );
  const chosen = execFileSync('xdg-mime', ['query', 'default', 'x-scheme-handler/https'], {
    encoding: 'utf8',
  }).trim();
  if (chosen !== name) throw new Error(`xdg-mime chose ${chosen || 'nothing'}, not ${name}`);
  return { handler: name, opener: 'xdg-open' };
}

function regQuery(key, value) {
  try {
    const out = execFileSync('reg.exe', ['query', key, ...(value ? ['/v', value] : ['/ve'])], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split(/\r?\n/).find((entry) => /REG_\w+/.test(entry));
    return line ? line.replace(/^.*?REG_\w+\s+/, '').trim() : null;
  } catch {
    return null;
  }
}

function registerWindows(log) {
  const command = `"${process.execPath}" "${RECORDER}" "${log}" "%1"`;
  const handlers = [];
  for (const scheme of ['http', 'https']) {
    const choice = regQuery(
      `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`,
      'ProgId',
    );
    // A per-user class shadows the machine's, so this redirects whichever
    // handler the system would pick without editing the protected choice.
    const progId = choice ?? scheme;
    execFileSync('reg.exe', [
      'add',
      `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`,
      '/ve',
      '/d',
      command,
      '/f',
    ]);
    handlers.push(`${scheme}: ${progId}${choice ? ' (user choice)' : ' (no user choice)'}`);
  }
  return { handler: handlers.join('; '), opener: 'rundll32 url.dll,FileProtocolHandler' };
}

/** Makes the recorder the default browser and returns how to read what it received. */
export function registerRecorder(log) {
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, '');
  const registration = process.platform === 'win32' ? registerWindows(log) : registerLinux(log);
  return {
    ...registration,
    received: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}
