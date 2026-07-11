// The persistent attribution + privacy line on every card. Line 1 attributes
// the figures to the agent's own reporting (honest provenance); line 2 states what
// TokenGauge reads and never reads. The "not a bill" caveat lives with the $ cost
// (technical details) — not here, where the metrics are percentages. agentLabel is
// a bounded, redacted display string from the VM — no raw path/id/secret reaches it.

export function PrivacyFooter({ agentLabel }: { readonly agentLabel: string }) {
  return (
    <footer className="tg-footer">
      <div className="tg-footer__line">{`Reported by ${agentLabel}`}</div>
      <div className="tg-footer__line">
        {"Reads only your agent's status — never your prompts, code, or logs"}
      </div>
    </footer>
  );
}
