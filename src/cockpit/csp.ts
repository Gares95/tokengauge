import { randomBytes } from 'node:crypto';

export interface CockpitCspOptions {
  readonly nonce: string;
  readonly webviewCspSource: string;
}

export function createNonce(): string {
  return randomBytes(24).toString('base64url');
}

export function buildCockpitCsp(options: CockpitCspOptions): string {
  return [
    "default-src 'none'",
    `img-src ${options.webviewCspSource} data:`,
    `style-src ${options.webviewCspSource} 'nonce-${options.nonce}'`,
    `script-src 'nonce-${options.nonce}'`,
    `font-src ${options.webviewCspSource}`,
    "connect-src 'none'",
  ].join('; ');
}
