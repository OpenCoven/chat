export interface MacosKeychainSession {
  backend: 'macos-keychain';
  home: string;
  keychainPath: string;
  close(): void;
}

export function prepareMacosKeychainSession(options: {
  home: string;
  platform?: NodeJS.Platform;
  execute?: (command: string, args: string[], home: string) => string;
  randomHex?: () => string;
}): MacosKeychainSession;
