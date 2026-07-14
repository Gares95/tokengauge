// The per-card status pill (dot + word). The TEXT label carries the meaning;
// the dot is decorative (aria-hidden) so risk/state is never conveyed by color
// alone (WCAG 1.4.1).

import type { BadgeTone } from './cardVisualState';

export function StateBadge({ tone, label }: { readonly tone: BadgeTone; readonly label: string }) {
  return (
    <span className={`tg-badge tg-badge--${tone}`}>
      <span className="tg-badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
