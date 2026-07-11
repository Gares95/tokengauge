// The single approved home for command-flow native
// notification surfaces.
//
// The command modules (delete-secrets, privacy report) take INJECTED
// native-UI seams so they
// stay clean against tools/check-no-stray-ui-surfaces.mjs. The extension
// wiring supplies those seams; the notification calls (`showInformationMessage`
// / `showErrorMessage`) live HERE, in one deliberately allowlisted file, rather
// than scattered through `extension.ts`. QuickPick/InputBox/SaveDialog are not
// gated, so they stay inline in the wiring layer.
//
// These helpers carry NO usage values, raw paths, secrets, or adapter
// internals — only short, already-sanitized status/preview copy assembled by
// the command modules.

import * as vscode from 'vscode';

export function notifyCommandResult(kind: 'info' | 'error', message: string): void {
  if (kind === 'error') {
    void vscode.window.showErrorMessage(message);
    return;
  }
  void vscode.window.showInformationMessage(message);
}

// Renders a metadata-only preview as a modal confirmation. Returns true when the
// user accepts the affirmative action. The detail string is pre-sanitized by the
// calling command module.
export async function confirmCommandPreview(
  detail: string,
  confirmLabel: string,
): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(detail, { modal: true }, confirmLabel);
  return choice === confirmLabel;
}
