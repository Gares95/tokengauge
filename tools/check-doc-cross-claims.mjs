// Cross-document claim gate.
//
// Link checkers verify that a heading EXISTS. They cannot verify that the
// heading still means what another document says it means. That gap shipped a
// real bug: after the writer body was deduplicated into a single block, the
// Windows setup guide still called the PowerShell section "the tested single
// source of the writer" — a section that by then held an eleven-line save
// recipe and no writer at all. Every link check passed.
//
// This gate closes that class: when a document makes a factual claim about the
// CONTENTS of a block elsewhere, the claim is checked against those contents.
// Reports rule + path + a short reason, never document content.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const violations = [];
const fail = (rule, file, detail) => violations.push({ rule, file, detail });

function read(file) {
  const full = join(root, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

// The body of a markdown block: from its heading to the next heading of the
// same or shallower level.
export function blockBody(content, heading) {
  const start = content.indexOf(heading);
  if (start === -1) return null;
  const after = start + heading.length;
  const level = (heading.match(/^#+/) ?? ['#'])[0].length;
  const next = new RegExp(`^#{1,${level}} `, 'm').exec(content.slice(after));
  return next === null ? content.slice(after) : content.slice(after, after + next.index);
}

// The marker that identifies a real writer body, not a recipe that mentions one.
const WRITER_BODY_MARKER = 'TOKENGAUGE_STATUSLINE_WRITER_START';

// Claims a document makes about a block in another document. Each is checked,
// not trusted.
const CLAIMS = [
  {
    rule: 'writer-block-claim',
    // Anything asserting a block is the source of the writer must name the block
    // that actually contains it.
    claimant: 'docs/setup/windows.md',
    mustNameBlock: '## WSL, Linux, macOS, or Git Bash',
    inFile: 'docs/claude-statusline-writer.md',
    reason: 'the guide points at the block said to hold the writer body',
  },
  {
    rule: 'writer-block-claim',
    claimant: 'docs/setup/wsl.md',
    mustNameBlock: '## WSL, Linux, macOS, or Git Bash',
    inFile: 'docs/claude-statusline-writer.md',
    reason: 'the guide points at the block said to hold the writer body',
  },
];

for (const claim of CLAIMS) {
  const claimant = read(claim.claimant);
  const target = read(claim.inFile);
  if (claimant === null || target === null) continue;

  // 1. the claimant must name the block it relies on
  if (!claimant.includes(claim.mustNameBlock)) {
    fail(claim.rule, claim.claimant, `does not name ${claim.mustNameBlock}`);
    continue;
  }
  // 2. that block must actually contain a writer body
  const body = blockBody(target, claim.mustNameBlock);
  if (body === null || !body.includes(WRITER_BODY_MARKER)) {
    fail(claim.rule, claim.inFile, `${claim.mustNameBlock} no longer contains the writer body`);
  }
}

// A guide must not name a block as the writer source when that block holds no
// writer. This is the exact shape of the shipped bug.
const WRITER_DOC = read('docs/claude-statusline-writer.md');
if (WRITER_DOC !== null) {
  for (const guide of ['docs/setup/windows.md', 'docs/setup/wsl.md']) {
    const content = read(guide);
    if (content === null) continue;
    for (const match of content.matchAll(/`(#{2,4} [^`]+)`/g)) {
      const named = match[1];
      const body = blockBody(WRITER_DOC, named);
      if (body === null) {
        fail('named-block-missing', guide, `the writer doc has no ${named}`);
        continue;
      }
      // Scope the test to the SENTENCE containing the reference. A wider window
      // catches assertions about a DIFFERENT block in an adjacent sentence, which
      // is a false positive: a guide may legitimately say one block holds the
      // writer and another saves it.
      const before = content.slice(0, match.index);
      const sentenceStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n\n'), 0);
      const rest = content.slice(match.index);
      const sentenceEnd = match.index + (rest.search(/\.\s|\n\n/) + 1 || rest.length);
      const sentence = content.slice(sentenceStart, sentenceEnd).toLowerCase();
      const assertsSource =
        /source of the writer|holds the writer|contains the writer|writer body/.test(sentence);
      if (assertsSource && !body.includes(WRITER_BODY_MARKER)) {
        fail(
          'writer-block-claim',
          guide,
          `names ${named} as the writer source, but that block holds no writer body`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Doc cross-claim gate violations:');
  for (const v of violations) console.error(`  [${v.rule}] ${v.file} - ${v.detail}`);
  process.exit(1);
}
console.log('OK: doc-cross-claims - every claim about another document matches its contents.');
