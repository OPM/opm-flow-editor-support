// ---------------------------------------------------------------------------
// Keywords that should be skipped by every diagnostic check.
//
// Some keywords have free-form or otherwise hard-to-validate record bodies
// where our generic checks (arity, record/list terminator, section validity)
// produce noisy false positives. The defaults below ship with the extension;
// users can override the list via the `opm-flow.diagnostics.excludedKeywords`
// VS Code setting, which the extension reads at activation and on change.
// ---------------------------------------------------------------------------

// RPTSCHED and the other RPT* report keywords are no longer excluded
// wholesale: the diagnostics engine now understands their free-form mnemonic
// bodies directly (see FREEFORM_MNEMONIC_KEYWORDS in analysis.ts), so the body
// is recognised without suppressing every other check on the keyword itself.
export const DEFAULT_DIAGNOSTICS_EXCLUDED_KEYWORDS: readonly string[] = [];

export const DIAGNOSTICS_EXCLUDED_KEYWORDS: ReadonlySet<string> = new Set(
  DEFAULT_DIAGNOSTICS_EXCLUDED_KEYWORDS,
);
