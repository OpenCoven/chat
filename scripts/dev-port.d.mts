export declare const DEFAULT_DEV_PORT: 4173;
export declare const DEV_PORT_ENV: 'OPENCOVEN_CHAT_DEV_PORT';
export declare function devPort(env?: Record<string, string | undefined>): number;
export declare function tauriDevArgs(port: number, extra?: readonly string[]): string[];
export declare function portIsFree(port: number, host?: string): Promise<boolean>;
export declare function portInUseMessage(port: number): string;
