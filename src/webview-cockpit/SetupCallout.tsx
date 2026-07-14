// The no-gauge body shown when a card has no usable value (not configured /
// probe off / CLI missing / blocked). Renders a title + message + a single CTA
// button — and crucially NO meter, so an unavailable source never looks like 0%
// usage. The CTA posts an existing read-only inbound message; it never sets a
// setting itself.

import type { SetupSpec } from './cardVisualState';

export function SetupCallout({
  spec,
  onCta,
}: {
  readonly spec: SetupSpec;
  readonly onCta: () => void;
}) {
  return (
    <div className="tg-setup">
      <div className="tg-setup__title">{spec.title}</div>
      <div className="tg-setup__msg">{spec.msg}</div>
      <button type="button" className="tg-cta" onClick={onCta}>
        {spec.ctaLabel}
      </button>
    </div>
  );
}
