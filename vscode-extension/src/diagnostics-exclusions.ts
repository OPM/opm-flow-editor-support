// ---------------------------------------------------------------------------
// Keywords that should be skipped by every diagnostic check.
//
// Some keywords have free-form or otherwise hard-to-validate record bodies
// where our generic checks (arity, record/list terminator, section validity)
// produce noisy false positives. List them here to silence all diagnostics
// for those keywords.
// ---------------------------------------------------------------------------

export const DIAGNOSTICS_EXCLUDED_KEYWORDS: ReadonlySet<string> = new Set([
  'RPTSCHED',
]);
