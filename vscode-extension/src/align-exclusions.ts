// ---------------------------------------------------------------------------
// Keywords whose record bodies are skipped by the column-alignment commands
// by default.
//
// "Align Record Columns" is meant for record *tables* — rows of a handful of
// fields, one record per line (WELSPECS, COMPDAT, WCONPROD, SWOF, PVTO, …).
// It is NOT useful on per-cell grid/region/solution arrays (PORO, PERMX,
// COORD, SATNUM, …) or on large structured tables (VFPPROD/VFPINJ): those are
// long streams of numbers that authors lay out in fixed-width columns on
// purpose, and collapsing them to single-space separation both destroys that
// layout and produces tens of thousands of edits when run across a full deck.
//
// These defaults ship with the extension and are merged with the user's
// `opm-flow.formatting.alignColumnsExcludedKeywords` setting (union). Names are
// compared in upper case.
// ---------------------------------------------------------------------------

export const DEFAULT_ALIGN_COLUMNS_EXCLUDED_KEYWORDS: readonly string[] = [
  // --- GRID: geometry ---
  'COORD', 'ZCORN', 'COORDSYS',
  'DX', 'DY', 'DZ', 'DXV', 'DYV', 'DZV', 'DRV', 'DTHETAV',
  'TOPS', 'DEPTHZ',
  // --- GRID: cell properties ---
  'PORO', 'PORV', 'MINPV', 'MINPVV',
  'PERMX', 'PERMY', 'PERMZ', 'PERMR', 'PERMTHT', 'PERMXY', 'PERMYZ', 'PERMZX',
  'NTG',
  'MULTX', 'MULTY', 'MULTZ', 'MULTX-', 'MULTY-', 'MULTZ-', 'MULTPV',
  'TRANX', 'TRANY', 'TRANZ',
  // --- REGIONS: per-cell region numbers ---
  'SATNUM', 'IMBNUM', 'PVTNUM', 'EQLNUM', 'FIPNUM', 'ROCKNUM', 'MULTNUM',
  'OPERNUM', 'FLUXNUM', 'EOSNUM', 'MISCNUM', 'ENDNUM',
  'KRNUMX', 'KRNUMY', 'KRNUMZ', 'IMBNUMX', 'IMBNUMY', 'IMBNUMZ',
  'ACTNUM',
  // --- SOLUTION: per-cell initial conditions ---
  'PRESSURE', 'SWAT', 'SGAS', 'SOIL', 'RS', 'RV', 'RVW', 'PBUB', 'PDEW',
  'TEMPI',
  // --- Large structured tables ---
  'VFPPROD', 'VFPINJ',
];
