// The persistent action-link row (Configure / Privacy & data / Diagnostics).
// Real <button>s styled as links (keyboard reachable, visible focus ring). Each
// posts an existing read-only inbound message via its handler — none sets a
// setting or carries a value.

export function ActionLinks({
  onConfigure,
  onPrivacy,
  onDiagnostics,
}: {
  readonly onConfigure: () => void;
  readonly onPrivacy: () => void;
  readonly onDiagnostics: () => void;
}) {
  return (
    <div className="tg-actions">
      <button type="button" className="tg-link" onClick={onConfigure}>
        Configure
      </button>
      <button type="button" className="tg-link" onClick={onPrivacy}>
        Privacy &amp; data
      </button>
      <button type="button" className="tg-link" onClick={onDiagnostics}>
        Diagnostics
      </button>
    </div>
  );
}
