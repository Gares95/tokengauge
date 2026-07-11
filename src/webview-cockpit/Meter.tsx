// The CSP-safe horizontal battery meter (fill = % REMAINING). Like RingGauge
// before it, the entire gauge is SVG presentation attributes + stylesheet classes
// — ZERO inline style attributes. The nonce CSP blocks inline styles, the
// webview-csp audit forbids any `style=` in this directory, and a render test
// asserts the tree carries no `style` prop. The fill WIDTH is an SVG geometry
// attribute (viewBox units), never a CSS width, so no inline style is needed; the
// rounded ends come from `overflow:hidden` + `border-radius` on the svg box.

import type { CardRisk } from '../cockpit/GaugeCardViewModel';

export type MeterLevel = 'ok' | 'warn' | 'crit';

// The viewBox height; preserveAspectRatio="none" stretches it to the CSS height.
const VIEW_H = 10;

// Presentation-only level from % remaining (handoff: <8 → crit, <20 → warn). Used
// for the secondary windows (weekly/context) that carry no per-window risk.
export function levelFromLeftPct(leftPct: number): MeterLevel {
  if (leftPct < 8) return 'crit';
  if (leftPct < 20) return 'warn';
  return 'ok';
}

// The primary 5h meter follows the host-derived card risk so its color and the
// "Near limit"/"Critical" badge never disagree (one threshold, host-side).
export function levelFromRisk(risk: CardRisk): MeterLevel {
  if (risk === 'critical') return 'crit';
  if (risk === 'warning') return 'warn';
  return 'ok';
}

export interface MeterProps {
  // Percentage REMAINING (0-100). Callers never render a meter for an unavailable
  // window (that path is a SetupCallout), so this is always a real value.
  readonly leftPct: number;
  readonly level: MeterLevel;
  readonly large?: boolean;
  readonly ariaLabel: string;
}

export function Meter({ leftPct, level, large = false, ariaLabel }: MeterProps) {
  const pct = Math.max(0, Math.min(100, Math.round(leftPct)));
  return (
    <svg
      className={large ? 'tg-meter tg-meter--lg' : 'tg-meter'}
      viewBox={`0 0 100 ${VIEW_H}`}
      preserveAspectRatio="none"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
    >
      <rect className="tg-meter__track" x="0" y="0" width="100" height={VIEW_H} />
      <rect className="tg-meter__fill" data-level={level} x="0" y="0" width={pct} height={VIEW_H} />
    </svg>
  );
}
