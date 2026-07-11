// The GaugeCardViewModel privacy gate.
//
// The VM/outbound-message surface is the trust chokepoint into the webview. It
// must clear the SAME sentinel rigor as every other persistence/display
// boundary: adversarial sentinel-bearing candidates in → a serialized
// gaugeCards message out with ZERO sentinel needles, closed-set reasons only,
// and no planType / hash keys.

import * as assert from 'node:assert/strict';
import { CockpitOutboundMessageSchema } from '../../src/cockpit/CockpitMessageSchema';
import {
  buildGaugeCardViewModels,
  type GaugeCardViewModel,
} from '../../src/cockpit/GaugeCardViewModel';
import { COCKPIT_FIELD_REASONS } from '../../src/core/cockpit/CockpitState';
import type { SourceCandidate } from '../../src/core/cockpit/SourcePriorityResolver';
import { PRIVACY_SENTINELS } from '../fixtures/privacy/sentinels';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const now = () => NOW;

// Raw-leak needles drawn from the fragment-assembled fixtures. Each class here
// is one the redactString backstop is CONTRACTED to neutralize (path, secret,
// oauth, git-remote, sentinel-constant). The raw session id is asserted absent
// because the VM excludes scope hashes/ids entirely — it never reaches a display
// string. (Email is intentionally NOT asserted: the project data policy does not
// enumerate bare email as a never-persist class and the shared Redactor — a
// cross-surface security primitive — does not strip it; adding a project-wide
// email rule here would be an out-of-scope change to that primitive.)
const RAW_SESSION_ID = '11111111-2222-3333-4444-555555555555';

const RAW_LEAK_NEEDLES = [
  PRIVACY_SENTINELS.fakePosixPath,
  PRIVACY_SENTINELS.fakeWindowsPath,
  PRIVACY_SENTINELS.fakeApiKey,
  PRIVACY_SENTINELS.fakeOAuthBearer,
  PRIVACY_SENTINELS.fakeGitRemote,
  RAW_SESSION_ID,
  '/home/dev/private',
];

// A candidate whose every display-bearing string field carries a distinct
// sentinel class. usedPct keeps the card visible so display strings are built.
function adversarialClaude(): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: NOW.getTime(),
    scope: {
      provider: 'anthropic',
      agent: 'claude-code',
      model: PRIVACY_SENTINELS.fakePosixPath,
    },
    confidence: 'high',
    session: { usedPct: 84, resetsAt: NOW.toISOString() },
    weekly: { usedPct: 40 },
    context: { usedPct: 30 },
    model: `${PRIVACY_SENTINELS.fakeApiKey} ${PRIVACY_SENTINELS.fakeGitRemote}`,
    reasoning: PRIVACY_SENTINELS.fakeWindowsPath,
    agentVersion: PRIVACY_SENTINELS.fakeOAuthBearer,
    planType: 'max-20x',
    workspaceHash: 'deadbeef'.repeat(8),
    sessionHash: RAW_SESSION_ID,
  };
}

function buildAdversarial(): GaugeCardViewModel[] {
  return buildGaugeCardViewModels({
    candidates: [adversarialClaude()],
    // codex configured with no candidates → empty-state card exercised too.
    configuredAgents: ['claude-code', 'codex'],
    now,
  });
}

suite('GaugeCardViewModel privacy invariants', () => {
  test('No sentinel needle survives into the serialized outbound message', () => {
    const cards = buildAdversarial();
    const message = { type: 'gaugeCards' as const, cards };
    const serialized = JSON.stringify(message);
    for (const needle of RAW_LEAK_NEEDLES) {
      assert.ok(
        !serialized.includes(needle),
        `gaugeCards message leaked needle: ${needle.slice(0, 24)}…`,
      );
    }
  });

  test('Every reason on every built VM is a member of the closed CockpitFieldReason union', () => {
    const cards = buildAdversarial();
    const allowed = new Set<string>(COCKPIT_FIELD_REASONS);
    for (const card of cards) {
      if (card.reason !== undefined) {
        assert.ok(allowed.has(card.reason), `card reason out of set: ${card.reason}`);
      }
      for (const gauge of [card.session, card.weekly, card.context]) {
        if (gauge.reason !== undefined) {
          assert.ok(allowed.has(gauge.reason), `gauge reason out of set: ${gauge.reason}`);
        }
      }
    }
  });

  test('Serialized message has no planType / workspaceHash / sessionHash key', () => {
    const cards = buildAdversarial();
    const serialized = JSON.stringify({ type: 'gaugeCards', cards });
    for (const forbidden of ['planType', 'workspaceHash', 'sessionHash', 'max-20x']) {
      assert.ok(!serialized.includes(forbidden), `forbidden key/value present: ${forbidden}`);
    }
  });

  test('The adversarial VM payload still passes the closed outbound schema', () => {
    const cards = buildAdversarial();
    const result = CockpitOutboundMessageSchema.safeParse({ type: 'gaugeCards', cards });
    assert.equal(result.success, true, 'sanitized VM must validate against the closed schema');
  });
});
