export function linuxSecretServicePackageCommands(): Array<{
  command: string;
  args: string[];
}>;

export function curateLinuxSecretServiceEnvironment(
  environment: NodeJS.ProcessEnv,
  expectedRuntimeRoot: string,
): Record<string, string>;

export function installLinuxSecretService(): void;
