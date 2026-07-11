/**
 * TOP-LEVEL IMPORTS ARE ACTIVATION-BUDGET-RELEVANT.
 * Keep this file's import graph as small as possible.
 *
 * NO-SECRETS-IN-SETTINGS CONTRACT: This file is the only path for
 * reading tokenGauge.* settings. SETTINGS MUST NEVER STORE SECRETS. Every
 * API-key-like value MUST go through SecretManager. Adding a
 * settings key whose name or default suggests a credential is a privacy
 * violation.
 */
import * as vscode from 'vscode';
import { type EffectiveConfig, TOKENGAUGE_KEYS, TOKENGAUGE_NAMESPACE } from './keys';

export class ConfigService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<EffectiveConfig>();
  public readonly onDidChange = this._onDidChange.event;

  private _snapshot: EffectiveConfig;
  private _pendingFlush: NodeJS.Immediate | undefined;
  private readonly _subscription: vscode.Disposable;

  public constructor() {
    this._snapshot = this.readAll();
    this._subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(TOKENGAUGE_NAMESPACE) || this._pendingFlush) {
        return;
      }

      this._pendingFlush = setImmediate(() => {
        this._pendingFlush = undefined;
        const next = this.readAll();
        this._snapshot = next;
        this._onDidChange.fire(next);
      });
    });
  }

  public snapshot(): EffectiveConfig {
    return this._snapshot;
  }

  public dispose(): void {
    this._subscription.dispose();
    if (this._pendingFlush) {
      clearImmediate(this._pendingFlush);
      this._pendingFlush = undefined;
    }
    this._onDidChange.dispose();
  }

  private readAll(): EffectiveConfig {
    const configuration = vscode.workspace.getConfiguration(TOKENGAUGE_NAMESPACE);
    const values: Record<string, unknown> = {};

    for (const key of TOKENGAUGE_KEYS) {
      const relativeKey = key.slice(`${TOKENGAUGE_NAMESPACE}.`.length);
      values[key] = configuration.get<unknown>(relativeKey);
    }

    return values as unknown as EffectiveConfig;
  }
}
