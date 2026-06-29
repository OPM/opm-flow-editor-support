// ---------------------------------------------------------------------------
// Curated keyword supplement.
//
// A small, hand-maintained set of keywords that OPM Flow accepts but that are
// absent from both the reference manual and opm-common's keyword database, so
// they never make it into the generated `keyword_index_compact.json`. Running
// the diagnostics engine over the known-good OPM/opm-tests corpus surfaced them
// as false-positive "unrecognised keyword" warnings (and, where a missing
// keyword swallowed its own data records, cascading warnings on well names).
//
// These are mostly CO2STORE / H2STORE / thermal / compositional keywords and a
// few compositional SUMMARY vectors. Each entry carries only what the engine
// needs to stop emitting false positives:
//
//   - SUMMARY vectors get their `sections` and a `size_kind` so a bare field
//     vector (no '/') and a well vector with an optional name list both parse.
//   - WELLSHUT is a SCHEDULE keyword taking a '/'-terminated well-name list, so
//     it must be `list`-shaped to absorb its records (otherwise the well names
//     under it are mis-flagged as keywords).
//   - The remaining PROPS/RUNSPEC keywords have numeric record bodies; they are
//     left without a `size_kind` or `sections` so they are merely *recognised*
//     and exempt from shape/section checks we cannot derive authoritatively.
//
// When opm-common or the manual gains any of these, drop it from here and
// regenerate the index.
// ---------------------------------------------------------------------------

import { AnalysisIndex, AnalysisEntry } from './analysis';

export const SUPPLEMENTAL_KEYWORDS: AnalysisIndex = {
  // --- Compositional / thermal SUMMARY vectors -----------------------------
  // Field-scope (F-prefix) vectors are written bare with no terminating '/'.
  FGDN:  { name: 'FGDN',  sections: ['SUMMARY'], size_kind: 'none' },
  FCGMM: { name: 'FCGMM', sections: ['SUMMARY'], size_kind: 'none' },
  FCGMI: { name: 'FCGMI', sections: ['SUMMARY'], size_kind: 'none' },
  FCWM:  { name: 'FCWM',  sections: ['SUMMARY'], size_kind: 'none' },
  // Well-scope (W-prefix) vectors take an optional '/'-terminated well list and
  // may be written bare and stacked.
  WCMPR: { name: 'WCMPR', sections: ['SUMMARY'], size_kind: 'array', optional_body: true },
  WCMIR: { name: 'WCMIR', sections: ['SUMMARY'], size_kind: 'array', optional_body: true },

  // --- SCHEDULE -------------------------------------------------------------
  // Shuts the listed wells; body is a '/'-terminated list of well names closed
  // by a standalone '/'.
  WELLSHUT: { name: 'WELLSHUT', sections: ['SCHEDULE'], size_kind: 'list' },

  // --- RUNSPEC / PROPS compositional & thermal keywords --------------------
  // Recognised only (numeric record bodies); no shape/section checks applied.
  STORE:    { name: 'STORE' },
  AIM:      { name: 'AIM' },
  CVTYPE:   { name: 'CVTYPE' },
  AMF:      { name: 'AMF' },
  PREFT:    { name: 'PREFT' },
  ZCRITVIS: { name: 'ZCRITVIS' },
  SPECHA:   { name: 'SPECHA' },
  SPECHB:   { name: 'SPECHB' },
  SPECHG:   { name: 'SPECHG' },
  SPECHH:   { name: 'SPECHH' },
};

/**
 * Merge the curated supplement into `index` in place, adding only keywords that
 * are not already present (a real index entry always wins). Returns `index` for
 * convenience.
 */
export function applyKeywordSupplement(index: AnalysisIndex): AnalysisIndex {
  for (const name in SUPPLEMENTAL_KEYWORDS) {
    if (index[name] === undefined) {
      index[name] = SUPPLEMENTAL_KEYWORDS[name] as AnalysisEntry;
    }
  }
  return index;
}

/**
 * Give every SUMMARY-section vector that lacks an explicit `size_kind` the
 * `array` shape. opm-common's probe expansion (and the L-modifier variants such
 * as CGMIRL, CGMPRL) emit recognised entries with no record shape, so their
 * optional, '/'-terminated name list — `CGMIRL` / `INJ1 /` / `/` — was parsed
 * with the well name mistaken for a new keyword. Every SUMMARY vector takes
 * that same optional name-list body, and the bare case (no names) is already
 * exempt from the terminator check, so `array` is the correct uniform shape.
 *
 * Mutates and returns `index`.
 */
export function normalizeSummaryVectorShapes(index: AnalysisIndex): AnalysisIndex {
  for (const name in index) {
    const entry = index[name];
    if (
      !entry.size_kind &&
      Array.isArray(entry.sections) &&
      entry.sections.includes('SUMMARY')
    ) {
      entry.size_kind = 'array';
    }
  }
  return index;
}

/**
 * Standard index preparation shared by the extension and the corpus harness:
 * add the curated supplement, then normalise SUMMARY-vector shapes. Mutates and
 * returns `index`.
 */
export function prepareKeywordIndex(index: AnalysisIndex): AnalysisIndex {
  applyKeywordSupplement(index);
  normalizeSummaryVectorShapes(index);
  return index;
}
