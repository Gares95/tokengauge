// The one-line "what's going on" summary (dot + text + sub). The dot is
// decorative (aria-hidden); the text carries the meaning so color is never the
// sole signal. The Refresh button and action links are placed beside/below it by
// CockpitView — this component is the status indicator only.

import type { BadgeTone, SummarySpec } from './cardVisualState';

// The summary dot uses the design's tone vocabulary (live/warn/muted/crit); map
// the shared BadgeTone onto it (stale → warn, blocked → crit).
const DOT_TONE: Record<BadgeTone, 'live' | 'warn' | 'muted' | 'crit'> = {
  live: 'live',
  stale: 'warn',
  muted: 'muted',
  blocked: 'crit',
};

export function SummaryStatus({ summary }: { readonly summary: SummarySpec }) {
  return (
    <div className="tg-summary__status" role="status">
      <div className="tg-summary__line">
        <span
          className={`tg-summary__dot tg-summary__dot--${DOT_TONE[summary.tone]}`}
          aria-hidden="true"
        />
        <span className="tg-summary__text">{summary.text}</span>
      </div>
      {summary.sub !== undefined ? <div className="tg-summary__sub">{summary.sub}</div> : null}
    </div>
  );
}
