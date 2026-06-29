// ---------------------------------------------------------------------------
// UDQ / ACTIONX vocabulary
//
// Static knowledge about the UDQ sub-language used by hover and completion.
// Kept free of any `vscode` dependency so it can be unit-tested directly; the
// extension wraps these into MarkdownString / CompletionItem objects.
// ---------------------------------------------------------------------------

/** Control words that introduce a statement inside a `UDQ` block. */
export const UDQ_CONTROL_WORDS: Readonly<Record<string, string>> = {
  ASSIGN:
    'Assign a constant value to a UDQ variable, optionally restricted to a set '
    + 'of wells/groups/regions by name or wildcard. Example: `ASSIGN WU1 \'OP*\' 1.0 /`.',
  DEFINE:
    'Define a UDQ variable as a formula of SUMMARY vectors, constants, other '
    + 'UDQs and UDQ functions; re-evaluated every report step. '
    + 'Example: `DEFINE WUPR1 1/(WWCT \'OP*\') /`.',
  UNITS:
    'Set the display unit string for a UDQ variable (informational only; it '
    + 'does not convert the value). Example: `UNITS WUPR1 \'BARSA\' /`.',
  UPDATE:
    'Control whether a UDQ variable is (re-)evaluated: `ON` evaluates every '
    + 'step, `OFF` freezes the current value, `NEXT` evaluates once at the next '
    + 'step. Example: `UPDATE WUPR1 OFF /`.',
};

export interface UdqFunction {
  /** Human-readable call signature, e.g. `SORTA(u)`. */
  readonly signature: string;
  /** One-line description. */
  readonly description: string;
}

/**
 * UDQ functions (OPM Flow reference manual, `UDQ` keyword). Element-wise
 * functions map over the set a UDQ ranges over; set functions reduce that set
 * to a single scalar.
 */
export const UDQ_FUNCTIONS: Readonly<Record<string, UdqFunction>> = {
  // Element-wise / scalar
  ABS:   { signature: 'ABS(u)',   description: 'Absolute value, element-wise.' },
  DEF:   { signature: 'DEF(u)',   description: 'Returns 1 where the operand is defined, undefined elsewhere.' },
  EXP:   { signature: 'EXP(u)',   description: 'Exponential e^u, element-wise.' },
  IDV:   { signature: 'IDV(u)',   description: 'Returns 1 where the operand is defined, 0 elsewhere.' },
  LN:    { signature: 'LN(u)',    description: 'Natural logarithm, element-wise.' },
  LOG:   { signature: 'LOG(u)',   description: 'Base-10 logarithm, element-wise.' },
  NINT:  { signature: 'NINT(u)',  description: 'Nearest integer, element-wise.' },
  RANDN: { signature: 'RANDN(u)', description: 'Gaussian (normal) random number per element.' },
  RANDU: { signature: 'RANDU(u)', description: 'Uniform random number in [0,1) per element.' },
  UNDEF: { signature: 'UNDEF(u)', description: 'Sets every element of the operand to undefined.' },
  // Set / aggregate (reduce to a scalar)
  SUM:   { signature: 'SUM(u)',   description: 'Sum over the defined elements of the set.' },
  AVEA:  { signature: 'AVEA(u)',  description: 'Arithmetic mean over the set.' },
  AVEG:  { signature: 'AVEG(u)',  description: 'Geometric mean over the set.' },
  AVEH:  { signature: 'AVEH(u)',  description: 'Harmonic mean over the set.' },
  MIN:   { signature: 'MIN(u)',   description: 'Minimum over the set.' },
  MAX:   { signature: 'MAX(u)',   description: 'Maximum over the set.' },
  PROD:  { signature: 'PROD(u)',  description: 'Product over the defined elements of the set.' },
  NORM1: { signature: 'NORM1(u)', description: 'L1 norm (sum of absolute values) over the set.' },
  NORM2: { signature: 'NORM2(u)', description: 'L2 norm (Euclidean) over the set.' },
  NORMI: { signature: 'NORMI(u)', description: 'Infinity norm (max absolute value) over the set.' },
  // Sorting / ranking
  SORTA: { signature: 'SORTA(u)', description: 'Rank the set in ascending order (1 = smallest).' },
  SORTD: { signature: 'SORTD(u)', description: 'Rank the set in descending order (1 = largest).' },
};

/** True for an UPPER-CASE token that is a UDQ control word. */
export function isUdqControlWord(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(UDQ_CONTROL_WORDS, word);
}

/** True for an UPPER-CASE token that is a known UDQ function. */
export function isUdqFunction(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(UDQ_FUNCTIONS, word);
}
