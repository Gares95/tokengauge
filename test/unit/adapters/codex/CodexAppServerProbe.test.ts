// CodexAppServerProbe unit tests.
//
// The probe drives a bounded, non-interactive `codex app-server` stdio JSON-RPC
// exchange (initialize → initialized → account/rateLimits/read → kill) behind an
// injectable runner seam. The REAL codex binary NEVER runs here: every test
// injects a fake runner that records the JSON-RPC writes and replays a sanitized
// fixture response. Every failure mode fails closed to a closed-set reason — no
// fabricated gauge, no raw error string, no stderr leak. Grep target:
// "CodexAppServerProbe".

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  CodexAppServerProbe,
  type CodexProbeExchange,
  type CodexProbeRunner,
  type CodexProbeRunRequest,
  extractCodexConfigFields,
  mapProbeResultToCandidate,
} from '../../../../src/adapters/codex/CodexAppServerProbe';
import { findRepoRoot } from '../../../_helpers/repoRoot';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    join(findRepoRoot(), 'test', 'fixtures', 'codex', 'app-server-ratelimits.json'),
    'utf8',
  ),
) as {
  initialize: Record<string, unknown>;
  rateLimits: Record<string, unknown>;
};

// A recording fake runner. It captures every JSON-RPC object written to the
// child and answers id-correlated requests from a supplied response map. `kill`
// increments a counter so tests can assert it ran exactly once.
interface FakeRunnerHandle {
  readonly writes: unknown[];
  killCount: number;
}

interface FakeRunnerOptions {
  readonly initializeResult?: unknown;
  readonly rateLimitsResult?: unknown;
  // When set, the runner throws on construction (generic failure path).
  readonly throwOnRun?: boolean;
  // When set, the request to account/rateLimits/read never resolves (timeout).
  readonly hangOnRateLimits?: boolean;
  // When set, the initialize request never resolves (timeout at the first stage).
  readonly hangOnInitialize?: boolean;
  // When set, the runner reports the binary was not found (ENOENT).
  readonly notFound?: boolean;
  // Raw response line override for a given id (e.g. malformed JSON).
  readonly rawLineForId?: Readonly<Record<number, string>>;
  // stderr the child emitted (must never surface in result/diagnostics).
  readonly stderr?: string;
}

function makeFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CodexProbeRunner;
  handle: FakeRunnerHandle;
  requests: CodexProbeRunRequest[];
} {
  const handle: FakeRunnerHandle = { writes: [], killCount: 0 };
  const requests: CodexProbeRunRequest[] = [];

  const runner: CodexProbeRunner = async (request) => {
    requests.push(request);
    if (options.throwOnRun) {
      throw new Error('spawn failed: internal-detail-should-never-surface');
    }
    if (options.notFound) {
      return {
        found: false,
        stderr: options.stderr ?? '',
        exchange: null,
        kill: () => {
          handle.killCount += 1;
        },
      };
    }

    const exchange: CodexProbeExchange = {
      writeLine: (obj: unknown) => {
        handle.writes.push(obj);
      },
      readResult: async (id: number) => {
        const raw = options.rawLineForId?.[id];
        if (raw !== undefined) {
          // Caller wants a malformed/raw line — parse failure surfaces as drift.
          return JSON.parse(raw) as unknown;
        }
        if (id === 1) {
          if (options.hangOnInitialize) {
            return await new Promise<never>(() => {
              /* never resolves — initialize-stage timeout */
            });
          }
          return options.initializeResult ?? FIXTURE.initialize;
        }
        if (id === 2) {
          if (options.hangOnRateLimits) {
            return await new Promise<never>(() => {
              /* never resolves — timeout exercised via injected clock */
            });
          }
          // The app-server returns the response wrapped as { rateLimits: {...} }.
          return options.rateLimitsResult ?? { rateLimits: FIXTURE.rateLimits };
        }
        throw new Error('unexpected id');
      },
    };

    return {
      found: true,
      stderr: options.stderr ?? '',
      exchange,
      kill: () => {
        handle.killCount += 1;
      },
    };
  };

  return { runner, handle, requests };
}

const NOW = () => new Date('2026-06-12T00:00:00.000Z');

function makeProbe(opts: FakeRunnerOptions = {}, timeoutMs?: number) {
  const { runner, handle, requests } = makeFakeRunner(opts);
  const diagnostics: { records: { ruleId: string; details?: unknown }[] } = { records: [] };
  const probe = new CodexAppServerProbe({
    runner,
    now: NOW,
    extensionVersion: '1.2.3',
    diagnostics: { record: (e) => diagnostics.records.push(e) },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { probe, handle, requests, diagnostics };
}

suite('CodexAppServerProbe: bounded JSON-RPC probe', () => {
  test('Fixture success → primary 5h + secondary weekly + version fingerprint', async () => {
    const { probe, handle } = makeProbe();
    const result = await probe.run();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.primary.usedPercent, 6);
    assert.equal(result.primary.windowDurationMins, 300);
    assert.equal(result.primary.resetsAt, 1781212269);
    assert.equal(result.secondary.windowDurationMins, 10080);
    assert.equal(result.planType, 'plus');
    assert.ok(result.codexVersion.includes('0.137.0'));
    // kill always runs exactly once on success.
    assert.equal(handle.killCount, 1);
  });

  test('Window sanity: primary not 300 → codex_protocol_drift', async () => {
    const { probe } = makeProbe({
      rateLimitsResult: {
        rateLimits: {
          primary: { usedPercent: 6, windowDurationMins: 60, resetsAt: 1781212269 },
          secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1781799069 },
        },
      },
    });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_protocol_drift');
  });

  test('Window sanity: secondary not 10080 → codex_protocol_drift', async () => {
    const { probe } = makeProbe({
      rateLimitsResult: {
        rateLimits: {
          primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1781212269 },
          secondary: { usedPercent: 1, windowDurationMins: 1440, resetsAt: 1781799069 },
        },
      },
    });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_protocol_drift');
  });

  test('ENOENT → codex_cli_not_found', async () => {
    const { probe } = makeProbe({ notFound: true });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_cli_not_found');
  });

  test('Timeout → codex_probe_timeout; kill invoked exactly once', async () => {
    const { probe, handle } = makeProbe({ hangOnRateLimits: true }, 20);
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_probe_timeout');
    assert.equal(handle.killCount, 1);
  });

  test('Malformed rateLimits line → codex_protocol_drift', async () => {
    const { probe } = makeProbe({ rawLineForId: { 2: '{"rateLimits":' + '"oops"}' } });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_protocol_drift');
  });

  test('UsedPercent out of 0..100 → codex_protocol_drift', async () => {
    const { probe } = makeProbe({
      rateLimitsResult: {
        rateLimits: {
          primary: { usedPercent: 150, windowDurationMins: 300, resetsAt: 1781212269 },
          secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1781799069 },
        },
      },
    });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_protocol_drift');
  });

  test('Runner throw → codex_probe_failed', async () => {
    const { probe } = makeProbe({ throwOnRun: true });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_probe_failed');
  });

  test('Hygiene: env is PATH + home vars only (no full host env), argv [app-server], no shell', async () => {
    const { probe, requests } = makeProbe();
    await probe.run();
    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.deepEqual([...req.args], ['app-server']);
    assert.equal(req.shell, false);
    const envKeys = Object.keys(req.env).sort();
    // Codex needs HOME/CODEX_HOME + the XDG/locale/shell vars a
    // login shell provides to start cleanly over a pipe; still NOT the full host env
    // — only this explicit allowlist may appear.
    const allowed = [
      'PATH',
      'HOME',
      'CODEX_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'XDG_RUNTIME_DIR',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'SHELL',
      'USER',
      'LOGNAME',
      'TERM',
      'TMPDIR',
      'NVM_DIR',
      'NVM_BIN',
      'PATHEXT',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
    ];
    for (const k of envKeys) {
      assert.ok(allowed.includes(k), `unexpected env key ${k}`);
    }
  });

  // Regression lock: the probe env MUST carry HOME (when the host has
  // it) so `codex app-server` can authenticate in WSL/Remote — without it the
  // rateLimits call hangs → codex_probe_timeout. NOT the full host env.
  test('Env carries HOME (when set) so codex can find ~/.codex/auth.json', async () => {
    const prior = process.env.HOME;
    process.env.HOME = '/home/tester';
    try {
      const { probe, requests } = makeProbe();
      await probe.run();
      assert.equal(requests[0]?.env.HOME, '/home/tester');
      // a clearly-unrelated host var must NOT be spread in.
      process.env.TG_UNRELATED_SECRET = 'nope';
      const { probe: p2, requests: r2 } = makeProbe();
      await p2.run();
      assert.equal(r2[0]?.env.TG_UNRELATED_SECRET, undefined, 'no full-host-env spread');
    } finally {
      if (prior === undefined) delete process.env.HOME;
      else process.env.HOME = prior;
      delete process.env.TG_UNRELATED_SECRET;
    }
  });

  // The allowlisted login-shell vars (XDG/locale) are forwarded
  // when present so app-server starts cleanly over a pipe — but still allowlisted.
  test('Env forwards allowlisted XDG/locale vars when set (not the full host env)', async () => {
    const priorXdg = process.env.XDG_RUNTIME_DIR;
    const priorLang = process.env.LANG;
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    process.env.LANG = 'en_US.UTF-8';
    try {
      const { probe, requests } = makeProbe();
      await probe.run();
      assert.equal(requests[0]?.env.XDG_RUNTIME_DIR, '/run/user/1000');
      assert.equal(requests[0]?.env.LANG, 'en_US.UTF-8');
    } finally {
      if (priorXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = priorXdg;
      if (priorLang === undefined) delete process.env.LANG;
      else process.env.LANG = priorLang;
    }
  });

  test('Env forwards allowlisted NVM resolver vars when set (not the full host env)', async () => {
    const nvmDirKey = 'NVM_DIR';
    const nvmBinKey = 'NVM_BIN';
    const nvmDirValue = 'fixture-nvm-dir';
    const nvmBinValue = 'fixture-nvm-bin';
    const priorDir = process.env[nvmDirKey];
    const priorBin = process.env[nvmBinKey];
    process.env[nvmDirKey] = nvmDirValue;
    process.env[nvmBinKey] = nvmBinValue;
    try {
      const { probe, requests } = makeProbe();
      await probe.run();
      assert.equal(requests[0]?.env.NVM_DIR, nvmDirValue);
      assert.equal(requests[0]?.env.NVM_BIN, nvmBinValue);
    } finally {
      if (priorDir === undefined) delete process.env[nvmDirKey];
      else process.env[nvmDirKey] = priorDir;
      if (priorBin === undefined) delete process.env[nvmBinKey];
      else process.env[nvmBinKey] = priorBin;
    }
  });

  test('Hygiene: stderr content never appears in result or diagnostics', async () => {
    const secret = '/home/dev/.codex/auth.json leaked-token-abc123';
    const { probe, diagnostics } = makeProbe({ throwOnRun: false, stderr: secret });
    // Force a failure so diagnostics record.
    const { probe: failingProbe, diagnostics: failingDiags } = makeProbe({
      notFound: true,
      stderr: secret,
    });
    const result = await probe.run();
    assert.ok(!JSON.stringify(result).includes('leaked-token'));
    assert.ok(!JSON.stringify(diagnostics.records).includes('leaked-token'));
    await failingProbe.run();
    assert.ok(!JSON.stringify(failingDiags.records).includes('leaked-token'));
    assert.ok(!JSON.stringify(failingDiags.records).includes('auth.json'));
  });

  test('Forbidden methods: no account/read, no thread/* ever written', async () => {
    const { probe, handle } = makeProbe();
    await probe.run();
    const methods = handle.writes
      .map((w) => (w as { method?: string }).method)
      .filter((m): m is string => typeof m === 'string');
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('initialized'));
    assert.ok(methods.includes('account/rateLimits/read'));
    for (const m of methods) {
      assert.ok(!m.startsWith('thread/'), `forbidden thread method written: ${m}`);
      assert.notEqual(m, 'account/read');
    }
  });

  test('Initialize payload leak: codexHome / path-like fields never reach result or diagnostics', async () => {
    const { probe, diagnostics } = makeProbe();
    const result = await probe.run();
    const serialized = JSON.stringify(result) + JSON.stringify(diagnostics.records);
    assert.ok(!serialized.includes('codexHome'));
    assert.ok(!serialized.includes('/home/dev/.codex'));
    assert.ok(!serialized.includes('requestUserAgent'));
    assert.ok(!/\/(home|Users)\//.test(serialized));
  });
});

suite('CodexAppServerProbe: result → codex_status_snapshot candidate', () => {
  async function successResult() {
    const { probe } = makeProbe();
    const result = await probe.run();
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected ok');
    return result;
  }

  test('Maps to codex_status_snapshot with session/weekly + agentVersion + scope', async () => {
    const result = await successResult();
    const candidate = mapProbeResultToCandidate(result, NOW);
    assert.equal(candidate.sourceTier, 'codex_status_snapshot');
    assert.deepEqual(candidate.scope, { provider: 'openai', agent: 'codex' });
    assert.equal(candidate.confidence, 'medium');
    assert.equal(candidate.session.usedPct, 6);
    assert.equal(candidate.session.leftPct, 94);
    assert.equal(candidate.session.resetsAt, new Date(1781212269 * 1000).toISOString());
    assert.equal(candidate.weekly.usedPct, 1);
    assert.equal(candidate.weekly.leftPct, 99);
    assert.ok(candidate.agentVersion.includes('0.137.0'));
    assert.equal(candidate.producedAtMs, NOW().getTime());
  });

  test('Context sub-object is ABSENT on the codex candidate (honest unavailable)', async () => {
    const result = await successResult();
    const candidate = mapProbeResultToCandidate(result, NOW);
    assert.equal((candidate as unknown as Record<string, unknown>).context, undefined);
  });

  test('Candidate carries no thread/context/workspace fields sourced from probe output', async () => {
    const result = await successResult();
    const candidate = mapProbeResultToCandidate(result, NOW);
    const keys = Object.keys(candidate);
    for (const forbidden of ['context', 'threadId', 'sessionHash', 'workspaceHash']) {
      assert.ok(!keys.includes(forbidden), `candidate must not carry ${forbidden}`);
    }
  });

  test('PlanType lands on the candidate (bounded)', async () => {
    const result = await successResult();
    const candidate = mapProbeResultToCandidate(result, NOW);
    assert.equal(candidate.planType, 'plus');
    assert.ok((candidate.planType ?? '').length <= 64);
  });

  // The reported-case regression guard. The
  // inline statusline showed ≈6–7% LEFT on the 5h window (≈93–94% USED). The probe
  // reports usedPercent directly, so a usedPercent of 93 must produce usedPct=93 /
  // leftPct=7 on the 5h (session) gauge — NEVER an inverted ~7% used, and NEVER the
  // weekly value cross-wired into the 5h slot.
  test(' reported case: ~6-7% left on the 5h window → ~93-94% USED, not inverted', async () => {
    const { probe } = makeProbe({
      rateLimitsResult: {
        rateLimits: {
          // 5h window: 93% USED (7% left). Near limit.
          primary: { usedPercent: 93, windowDurationMins: 300, resetsAt: 1781212269 },
          // weekly window: a DISTINCT, lower value to prove no cross-wiring.
          secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1781799069 },
        },
      },
    });
    const result = await probe.run();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const candidate = mapProbeResultToCandidate(result, NOW);
    // 5h (session) gauge reflects the 5h window: 93 used / 7 left — NOT inverted.
    assert.equal(candidate.session.usedPct, 93, '5h usedPct must be the reported 93, not ~7');
    assert.equal(candidate.session.leftPct, 7, '5h leftPct = 100 - used');
    assert.ok(candidate.session.usedPct >= 90, 'near-limit 5h must read >=90% used, not ~77-80%');
    // weekly gauge reflects the weekly window — the 5h value is never cross-wired.
    assert.equal(candidate.weekly.usedPct, 22, 'weekly usedPct is the weekly window value');
    assert.equal(candidate.weekly.leftPct, 78);
    assert.notEqual(
      candidate.weekly.usedPct,
      candidate.session.usedPct,
      'weekly and 5h are distinct windows — no cross-wire',
    );
  });

  // The 5h window comes from `primary` (300min) and weekly from
  // `secondary` (10080min). A response that SWAPS the durations is protocol drift
  // (matchedWindow), so the gauges can never silently read the wrong window.
  test(' swapped window durations fail closed to codex_protocol_drift (no wrong-window)', async () => {
    const { probe } = makeProbe({
      rateLimitsResult: {
        rateLimits: {
          // primary carries the WEEKLY duration and secondary the 5h duration.
          primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1781799069 },
          secondary: { usedPercent: 93, windowDurationMins: 300, resetsAt: 1781212269 },
        },
      },
    });
    const result = await probe.run();
    assert.equal(result.ok, false, 'a swapped-window response must not produce a candidate');
    if (result.ok) return;
    assert.equal(result.reason, 'codex_protocol_drift');
  });
});

suite('CodexAppServerProbe: bounded config.toml extraction (no path leak)', () => {
  test('Extracts only top-level model + reasoning before the first section', () => {
    const toml = [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[projects."/home/user/secret-path"]',
      'trust_level = "trusted"',
      'model = "should-not-be-read"',
    ].join('\n');
    const fields = extractCodexConfigFields(toml);
    assert.deepEqual(fields, { model: 'gpt-5.5', reasoning: 'xhigh' });
    const serialized = JSON.stringify(fields);
    assert.ok(!serialized.includes('secret-path'));
    assert.ok(!/\/(home|Users)\//.test(serialized));
  });

  test('Config absent/empty → model and reasoning simply absent', () => {
    assert.deepEqual(extractCodexConfigFields(''), {});
    assert.deepEqual(extractCodexConfigFields('# just a comment\n'), {});
  });

  test('A path-like config value is neutralized, never passed through raw', () => {
    const toml = 'model = "/home/user/evil"\n';
    const fields = extractCodexConfigFields(toml);
    assert.ok(!/\/(home|Users)\//.test(JSON.stringify(fields)));
  });

  test('The raw section path never appears in any extractor output', () => {
    const toml = '[projects."/home/user/secret-path"]\nmodel = "x"\n';
    const fields = extractCodexConfigFields(toml);
    assert.equal(JSON.stringify(fields), '{}');
  });
});

// Sanitized stage markers make an installed-VSIX timeout diagnosable
// — they tell WHERE the JSON-RPC exchange hung, without any raw payload/path/account.
suite('CodexAppServerProbe: sanitized stage markers', () => {
  test('Success → stage "completed"', async () => {
    const { probe } = makeProbe();
    const result = await probe.run();
    assert.equal(result.stage, 'completed');
  });

  test('Timeout waiting for initialize → reason timeout + stage initialize_sent', async () => {
    const { probe, diagnostics } = makeProbe({ hangOnInitialize: true }, 20);
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_probe_timeout');
    assert.equal(result.stage, 'initialize_sent', 'app-server never answered initialize');
    // the stage is recorded in the rule-id-only diagnostic detail (no payload).
    const rec = diagnostics.records.at(-1);
    assert.equal((rec?.details as { stage?: string } | undefined)?.stage, 'initialize_sent');
  });

  test('Timeout waiting for rateLimits → reason timeout + stage ratelimits_sent', async () => {
    const { probe } = makeProbe({ hangOnRateLimits: true }, 20);
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_probe_timeout');
    assert.equal(result.stage, 'ratelimits_sent', 'initialize ok, status call hung');
  });

  test('Binary not found → reason cli_not_found + stage cli_not_found', async () => {
    const { probe } = makeProbe({ notFound: true });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_cli_not_found');
    assert.equal(result.stage, 'cli_not_found');
  });

  test('Throwing runner → reason failed + stage run_threw (no stderr leak)', async () => {
    const { probe } = makeProbe({ throwOnRun: true });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_probe_failed');
    assert.equal(result.stage, 'run_threw');
  });

  test('Protocol drift → stage ratelimits_received (got a response, failed to parse)', async () => {
    const { probe } = makeProbe({ rawLineForId: { 2: '{"rateLimits":"oops"}' } });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_protocol_drift');
    assert.equal(result.stage, 'ratelimits_received');
  });

  // round 9: the probe reports the FURTHEST I/O milestone + a stderr-seen boolean
  // from the runner's onIo seam, so a WSL hang is diagnosable (no stdout chunk vs
  // chunk-no-line vs parsed-no-match). Drives onIo directly via a custom runner.
  test('Reports the furthest I/O stage + stderr-seen from the runner onIo seam', async () => {
    const emitted = [
      'stdin_write_started',
      'stdin_write_completed',
      'stdout_chunk_received',
      'stdout_line_received',
      'stdout_json_parsed',
      'response_matched',
      'stderr_chunk',
    ] as const;
    const runner: CodexProbeRunner = async (request) => {
      for (const e of emitted) request.onIo?.(e);
      const exchange: CodexProbeExchange = {
        writeLine: () => {},
        readResult: async (id: number) =>
          id === 1 ? FIXTURE.initialize : { rateLimits: FIXTURE.rateLimits },
      };
      return { found: true, stderr: '', exchange, kill: () => {} };
    };
    const probe = new CodexAppServerProbe({ runner, now: NOW, extensionVersion: '1.2.3' });
    const result = await probe.run();
    assert.equal(result.ioStage, 'response_matched', 'furthest I/O stage surfaced');
    assert.equal(result.sawStderr, true, 'stderr-seen boolean surfaced');
  });

  test('No I/O events → ioStage stays none (e.g. child never flushed stdout)', async () => {
    const runner: CodexProbeRunner = async () => ({
      found: true,
      stderr: '',
      // readResult never resolves → timeout with NO onIo I/O events at all.
      exchange: {
        writeLine: () => {},
        readResult: () => new Promise<never>(() => {}),
      },
      kill: () => {},
    });
    const probe = new CodexAppServerProbe({
      runner,
      now: NOW,
      extensionVersion: '1',
      timeoutMs: 20,
    });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codex_probe_timeout');
    assert.equal(result.ioStage, 'none', 'no stdout chunk ⇒ child never flushed to our pipe');
  });
});

// The probe forwards an explicit cwd to the runner and
// surfaces a child-exit bucket + stdout-chunk count, so an ext-host runtime hang is
// diagnosable (0 chunks + exit nonzero ⇒ wrong binary; 0 chunks + exit none ⇒ hang).
suite('CodexAppServerProbe: cwd + exit-bucket diagnostics', () => {
  test('Forwards the configured cwd to the runner request', async () => {
    let seenCwd: string | undefined;
    const runner: CodexProbeRunner = async (request) => {
      seenCwd = request.cwd;
      return {
        found: true,
        stderr: '',
        exchange: {
          writeLine: () => {},
          readResult: async (id: number) =>
            id === 1 ? FIXTURE.initialize : { rateLimits: FIXTURE.rateLimits },
        },
        kill: () => {},
      };
    };
    const probe = new CodexAppServerProbe({
      runner,
      now: NOW,
      extensionVersion: '1',
      cwd: '/home/tester',
    });
    await probe.run();
    assert.equal(seenCwd, '/home/tester');
  });

  test('A child that exits early surfaces a nonzero exit bucket (wrong binary / startup error)', async () => {
    const runner: CodexProbeRunner = async (request) => {
      request.onExit?.('nonzero');
      return {
        found: true,
        stderr: '',
        exchange: { writeLine: () => {}, readResult: () => new Promise<never>(() => {}) },
        kill: () => {},
      };
    };
    const probe = new CodexAppServerProbe({
      runner,
      now: NOW,
      extensionVersion: '1',
      timeoutMs: 20,
    });
    const result = await probe.run();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.exitBucket, 'nonzero');
    assert.equal(result.stdoutChunks, 0);
  });
});
