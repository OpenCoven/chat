// What the platform screen reader said: VoiceOver's last phrase through its
// AppleScript interface, NVDA's speech log at IO level, Orca's debug log. Each
// reader is started by the lane and reads the app through its accessibility
// tree, exactly as it would for a person.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM, sleep, until } from './driver.mjs';

function osascript(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 15_000 }).trim();
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
    spawn('/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter', [], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    await until(
      'VoiceOver to answer AppleScript',
      async () => {
        try {
          osascript('tell application "VoiceOver" to return bounds of vo cursor');
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
  mark() {
    return this.last();
  }
  last() {
    try {
      return osascript('tell application "VoiceOver" to return content of last phrase');
    } catch (error) {
      return `(unreadable: ${error.message.split('\n')[0]})`;
    }
  }
  /** VoiceOver keeps only its last phrase; wait for it to change, then settle. */
  async since(previous, wait = 6_000) {
    const deadline = Date.now() + wait;
    let phrase = this.last();
    while (phrase === previous && Date.now() < deadline) {
      await sleep(250);
      phrase = this.last();
    }
    await sleep(800);
    const settled = this.last();
    return settled === previous ? [] : [settled];
  }
  stop() {
    try {
      osascript('tell application "VoiceOver" to quit');
    } catch {
      // Already gone.
    }
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
  stop() {
    try {
      execFileSync(this.executable, ['-q'], { timeout: 20_000 });
    } catch {
      this.child?.kill();
    }
  }
}

class Orca extends LogReader {
  name = 'Orca';
  constructor(out) {
    super(join(out, 'orca.log'), /SPEECH OUTPUT: '(.*)'/);
  }
  async start() {
    this.child = spawn('orca', ['--replace', `--debug-file=${this.path}`], {
      detached: true,
      stdio: 'ignore',
    });
    this.child.unref();
    await until('Orca to write its log', async () => existsSync(this.path), 60_000, 1_000);
    await sleep(5_000);
    this.started = true;
  }
  stop() {
    this.child?.kill();
  }
}

export function screenReader({ out, nvda }) {
  if (PLATFORM === 'mac') return new VoiceOver();
  if (PLATFORM === 'windows') return nvda ? new Nvda(nvda, out) : null;
  return new Orca(out);
}
