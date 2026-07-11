// TokenGauge-owned provider reminder badges. These are original, distinct
// TokenGauge artwork used purely to help users tell the Claude and Codex cards
// apart at a glance — they are NOT official Anthropic/Claude or OpenAI/Codex
// logos and imply no endorsement. The badge is decorative (aria-hidden); the
// provider NAME text next to it carries the actual label, and card STATE is
// carried by StateBadge (text + dot), so the badge colour is never the sole
// signal. Inlined as SVG DOM (no fetched asset, no `data:` URI, no external
// font) so the strict webview CSP and the VSIX packaging surface are unchanged.
//
// SVG presentation attributes MUST be hyphenated (`stop-color`, `stroke-width`,
// …). Preact renders JSX attributes verbatim and does NOT camelCase-convert them
// the way React does — camelCase `stopColor` renders as an ignored attribute, so
// the gradient stops would default to black. Match the DOM attribute names.

function ClaudeBadge() {
  return (
    <svg viewBox="0 0 48 48" className="tg-provider-badge__svg" aria-hidden="true">
      <rect x="0" y="0" width="48" height="48" rx="9" ry="9" fill="#F66143" />
      <g fill="none" stroke="#FFFFFF" stroke-linecap="round" stroke-linejoin="round">
        <line x1="23.6" y1="23.1" x2="7.4" y2="22.9" stroke-width="2.25" />
        <line x1="23.4" y1="23.0" x2="10.6" y2="14.4" stroke-width="2.05" />
        <line x1="23.8" y1="23.2" x2="14.8" y2="7.8" stroke-width="2.00" />
        <line x1="24.0" y1="23.5" x2="24.0" y2="6.8" stroke-width="2.35" />
        <line x1="24.2" y1="23.3" x2="33.6" y2="8.2" stroke-width="2.10" />
        <line x1="24.3" y1="23.2" x2="39.6" y2="14.0" stroke-width="2.20" />
        <line x1="24.4" y1="23.0" x2="41.0" y2="22.8" stroke-width="2.30" />
        <line x1="24.4" y1="23.5" x2="38.6" y2="35.2" stroke-width="2.10" />
        <line x1="24.1" y1="23.7" x2="33.5" y2="41.0" stroke-width="2.00" />
        <line x1="24.0" y1="23.8" x2="24.3" y2="42.3" stroke-width="2.30" />
        <line x1="23.8" y1="23.7" x2="14.5" y2="40.8" stroke-width="2.05" />
        <line x1="23.5" y1="23.4" x2="10.4" y2="34.7" stroke-width="2.15" />
      </g>
    </svg>
  );
}

function CodexBadge() {
  return (
    <svg viewBox="0 0 48 48" className="tg-provider-badge__svg" aria-hidden="true">
      <defs>
        <linearGradient id="tg-codex-badge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#5AA6FF" />
          <stop offset="1" stop-color="#2F7BEA" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="12" fill="url(#tg-codex-badge)" />
      <rect
        x="1.5"
        y="1.5"
        width="45"
        height="45"
        rx="11.5"
        fill="none"
        stroke="#FFFFFF"
        stroke-opacity="0.16"
      />
      <g
        fill="none"
        stroke="#F4F8FF"
        stroke-width="3.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M16 18 L24 24 L16 30" />
        <path d="M27 30 L33 30" />
      </g>
    </svg>
  );
}

// The badge for a provider. Known providers render their TokenGauge badge art;
// anything else keeps the plain CSS monogram letter (fallbackLabel) so new
// adapters still get a sensible identifier without bespoke artwork.
export function ProviderBadge({
  colorKey,
  fallbackLabel,
}: {
  readonly colorKey: string;
  readonly fallbackLabel: string;
}) {
  if (colorKey === 'claude') {
    return (
      <div className="tg-monogram tg-monogram--art" data-agent="claude" aria-hidden="true">
        <ClaudeBadge />
      </div>
    );
  }
  if (colorKey === 'codex') {
    return (
      <div className="tg-monogram tg-monogram--art" data-agent="codex" aria-hidden="true">
        <CodexBadge />
      </div>
    );
  }
  return (
    <div className="tg-monogram" aria-hidden="true">
      {fallbackLabel}
    </div>
  );
}
