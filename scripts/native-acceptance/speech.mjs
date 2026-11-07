// What the platform screen reader said: VoiceOver's last phrase through its
// AppleScript interface, NVDA's speech log at IO level, Orca's debug log. Each
// reader is started by the lane and reads the app through its accessibility
// tree, exactly as it would for a person.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PLATFORM, sleep, until } from './driver.mjs';

const run = promisify(execFile);

async function osascript(script, timeout = 8_000) {
  const { stdout } = await run('osascript', ['-e', script], { encoding: 'utf8', timeout });
  return stdout.trim();
}

function running(name) {
  try {
    execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

class VoiceOver {
  name = 'VoiceOver';
  async start() {
    for (const [domain, key, type, value] of [
      ['com.apple.VoiceOver4/default', 'SCREnableAppleScript', '-bool', 'true'],
      ['com.apple.VoiceOverTraining', 'doNotShowSplashScreen', '-bool', 'true'],
      [
        'com.apple.VoiceOver4/default',
        'SCRCategories_SCRCategorySystemWideSettings_SCRSpeakingRateQuickChangeEnabled',
        '-bool',
        'false',
      ],
    ]) {
      execFileSync('defaults', ['write', domain, key, type, value]);
    }
    // A VoiceOver that is still quitting from the last check would swallow the start.
    await until('the last VoiceOver to quit', async () => !running('VoiceOver'), 15_000, 500);
    spawn('/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter', [], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    await until(
      'VoiceOver to answer AppleScript',
      async () => {
        try {
          await osascript('tell application "VoiceOver" to return bounds of vo cursor');
          return true;
        } catch {
          return false;
        }
      },
      60_000,
      1_000,
    );
    this.started = true;
  }
  async last() {
    try {
      return await osascript(
        'tell application "VoiceOver" to return content of last phrase',
        5_000,
      );
    } catch {
      return null;
    }
  }
  /** Waits for VoiceOver's start-up speech to stop changing. */
  async settle() {
    let previous = await this.last();
    let stable = 0;
    for (let index = 0; index < 40 && stable < 8; index += 1) {
      await sleep(250);
      const phrase = await this.last();
      stable = phrase === previous ? stable + 1 : 0;
      previous = phrase;
    }
  }
  /**
   * VoiceOver keeps only its last phrase, so a watcher polls it from the mark
   * on and keeps each new phrase, in order.
   */
  async mark() {
    const watch = { phrases: [], done: false, unread: 0, polls: 0 };
    let previous = await this.last();
    watch.first = previous;
    watch.loop = (async () => {
      while (!watch.done) {
        const phrase = await this.last();
        watch.polls += 1;
        if (phrase === null) watch.unread += 1;
        else if (phrase !== previous) {
          watch.phrases.push(phrase);
          previous = phrase;
        }
        await sleep(100);
      }
    })();
    return watch;
  }
  async since(watch, wait = 6_000) {
    const deadline = Date.now() + wait;
    while (!watch.phrases.length && Date.now() < deadline) await sleep(200);
    // Name, role and value can arrive as separate phrases.
    await sleep(2_500);
    watch.done = true;
    await watch.loop;
    this.diagnostics = { before: watch.first, polls: watch.polls, unreadable: watch.unread };
    return watch.phrases;
  }
  async stop() {
    try {
      await osascript('tell application "VoiceOver" to quit');
    } catch {
      // Already gone.
    }
    await until('VoiceOver to quit', async () => !running('VoiceOver'), 15_000, 500).catch(() => {
      try {
        execFileSync('killall', ['VoiceOver'], { stdio: 'ignore' });
      } catch {
        // Gone.
      }
    });
  }
}

/** Reads phrases from a log file that grows; `mark` is a line count. */
class LogReader {
  constructor(path, pattern) {
    this.path = path;
    this.pattern = pattern;
  }
  phrases() {
    if (!existsSync(this.path)) return [];
    const found = [];
    for (const line of readFileSync(this.path, 'utf8').split(/\r?\n/)) {
      const match = this.pattern.exec(line);
      if (match) found.push(match[1]);
    }
    return found;
  }
  mark() {
    return this.phrases().length;
  }
  async since(mark, wait = 6_000) {
    const deadline = Date.now() + wait;
    while (this.phrases().length === mark && Date.now() < deadline) await sleep(250);
    await sleep(1_200);
    return this.phrases().slice(mark);
  }
}

class Nvda extends LogReader {
  name = 'NVDA';
  constructor(executable, out) {
    super(join(out, 'nvda.log'), /^Speaking (.*)$/);
    this.executable = executable;
  }
  async start() {
    rmSync(this.path, { force: true });
    this.child = spawn(
      this.executable,
      ['--log-file', this.path, '--log-level=12', '--minimal', '--disable-addons'],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    this.child.unref();
    await until(
      'NVDA to start speaking',
      async () => this.phrases().length > 0 || existsSync(this.path),
      60_000,
      1_000,
    );
    await sleep(3_000);
    this.started = true;
  }
  async stop() {
    try {
      execFileSync(this.executable, ['-q'], { timeout: 20_000 });
    } catch {
      this.child?.kill();
    }
  }
}

class Orca extends LogReader {
  name = 'Orca';
  sessions = 0;
  constructor(out) {
    // The utterance is quoted and followed by Orca's voice settings: 'text' {...}
    super(join(out, 'orca-0.log'), /SPEECH OUTPUT: '(.*?)'(?: \{.*)?$/);
    this.out = out;
  }
  async start() {
    // One log per session, so each check's events stay on record.
    this.sessions += 1;
    this.path = join(this.out, `orca-${this.sessions}.log`);
    rmSync(this.path, { force: true });
    // Orca's own output is kept: a start that stalls says why there.
    const output = openSync(join(this.out, 'orca-output.txt'), 'a');
    this.child = spawn('orca', ['--replace', `--debug-file=${this.path}`], {
      detached: true,
      stdio: ['ignore', output, output],
    });
    this.child.unref();
    await until(
      'Orca to finish starting',
      async () =>
        existsSync(this.path) &&
        /main event loop|ORCA: Initialized|SPEECH OUTPUT/i.test(readFileSync(this.path, 'utf8')),
      60_000,
      1_000,
    );
    await sleep(2_000);
    this.started = true;
  }
  async stop() {
    this.child?.kill();
    await sleep(1_000);
  }
}

export function screenReader({ out, nvda }) {
  if (PLATFORM === 'mac') return new VoiceOver();
  if (PLATFORM === 'windows') return nvda ? new Nvda(nvda, out) : null;
  return new Orca(out);
}
