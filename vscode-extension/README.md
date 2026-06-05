# OPM Flow VS Code Extension

Language support for [OPM Flow](https://opm-project.org/) reservoir simulation deck files,
with syntax highlighting and development features backed by the full OPM Flow reference manual.

<!-- manual-ref:start -->
Keyword data is built from [OPM/opm-reference-manual](https://github.com/OPM/opm-reference-manual) at commit [`9baa939b`](https://github.com/OPM/opm-reference-manual/commit/9baa939bff52bc55218adff79b9f8c806fb680dd).
<!-- manual-ref:end -->

## Features

### Syntax Highlighting

Provides syntax highlighting for OPM Flow simulation deck files with support for:

- **Section headers**: `RUNSPEC`, `GRID`, `EDIT`, `PROPS`, `REGIONS`, `SOLUTION`, `SUMMARY`, `SCHEDULE` — scoped so most themes render them in a distinct color (yellow in Dark+)
- **Keywords**: ALL_CAPS identifiers (e.g., `COMPDAT`, `WELSPECS`, `DATES`)
- **Comments**: Lines starting with `--`
- **Record terminators**: `/` marking the end of a record
- **Numbers**: Integers and floating-point values
- **Defaults / repeat markers**: `1*`, `3*`, etc. (distinct from ordinary numbers)
- **Strings**: Text in single quotes
- **Template variables**: `<NAME>` placeholders used in macro/ERT workflows
- **END keyword**: Specially highlighted file terminator

### Keyword Autocompletion

Autocomplete support for OPM Flow keywords extracted from the reference manual.
Each completion item shows the deck section(s) the keyword is valid in
(`RUNSPEC`, `GRID`, `SCHEDULE`, …) and a one-line summary in the documentation
pane. Keywords that are valid in every section (e.g. `INCLUDE`, `ECHO`) list
them all. Completions are triggered when typing uppercase letters at the start
of a line.

### Parameter Value Completion

Inside a record, when the parameter at the current column has a known set of
string options, the suggestion list shows them with a one-line description per
option. For example, on a `COMPDAT` record the `STATUS` column offers
`OPEN`, `SHUT`, and `AUTO`. Multi-record keywords resolve the parameter against
the record the cursor is in, so each record gets the right option list.

To activate the list, position the cursor in the parameter column and either
start typing an uppercase letter (e.g. `O` for `OPEN`) or press
`Ctrl+Space` (`Cmd+Space` on macOS) to open the suggestions manually. Selecting
an option inserts the value quoted, e.g. `'OPEN'`.

### Hover Tooltips

Hover over any keyword to see a quick tooltip with:

- The **keyword name and all valid sections**
- A **summary** from the reference manual
- A **parameter table** listing all record fields with units and defaults
- A usage **example**

Hovering over a **value in a data record** shows the description for that specific
parameter column. For example, hovering over the group name in a `WELSPECS` record
shows the `GRPNAME` parameter description, units, and default.

Keywords on the diagnostics exclusion list (see `opm-flow.diagnostics.excludedKeywords`
under [Settings](#settings)) carry an extra notice in the hover indicating that
arity, terminator, and section checks are skipped — useful when squiggles are
deliberately suppressed for a keyword.

### Diagnostics

Squiggles in the editor catch the most common deck-shape mistakes:

- **Unrecognised keyword** — a keyword-shaped line whose token isn't in the
  OPM Flow vocabulary (typo of an identifier, or a custom keyword the parser
  won't accept).
- **Wrong section** — a keyword used outside the section(s) it's valid in,
  e.g. `WELSPECS` placed in `RUNSPEC` instead of `SCHEDULE`. The hover lists
  the sections where it *is* valid.
- **Over-arity record** — a record with more values than the keyword's
  per-record item count from the OPM Flow parser. Trailing defaults
  (auto-defaulted by `/`) are not flagged. The squiggle starts at the first
  offending value, including `N*` repeat tokens.
- **Missing per-record `/`** — a record line carrying values but no closing
  `/`, on keywords known to take records.
- **Missing closing `/` on record-list blocks** — keywords like `WELSPECS`,
  `COMPDAT`, `WCONHIST` that expect the block to end with a standalone `/`
  line.
- **Missing closing `/` on array blocks** — cell-property arrays like
  `PORO`, `PERMX`, `ACTNUM`, `OPERNUM`, `ZCORN`. The closing `/` may sit on
  its own line or trail the last value line — both forms are accepted.
- **Indented keyword** — a recognised keyword that doesn't start in column 1.
  Per the OPM Flow reference manual, indented keywords are silently ignored
  by the simulator.
- **Lowercase keyword** — a line shaped like a keyword declaration whose
  upper-cased form is a known keyword. The reference manual states that
  lowercase keywords produce errors at simulation time.

Keywords whose record bodies don't fit the generic model can be silenced
wholesale via the `opm-flow.diagnostics.excludedKeywords` setting — see
[Settings](#settings) below.

### Docs Panel (Sidebar)

Open the **Explorer** sidebar (`Ctrl+Shift+E`) and scroll down to the **OPM Keyword Reference** panel.
It updates automatically as you move the cursor — no keystrokes needed:

- **Cursor on a keyword** → full documentation: valid sections, summary, complete parameter table, example
- **Cursor on a value column** → same view with the matching parameter row highlighted
- **Cursor on whitespace or a comment** → panel retains the last shown keyword

The panel shows the keyword name, the section(s) it applies to, the summary,
the parameter table, and the example. This is the main view for reading long
keyword documentation, since it scrolls freely and stays visible while you edit.

### Collapse Sections and Keywords

Sections and individual keywords can be folded in the editor gutter. A section
runs from a section keyword (`RUNSPEC`, `GRID`, `EDIT`, `PROPS`, `REGIONS`,
`SOLUTION`, `SUMMARY`, `SCHEDULE`) until the next section keyword,
`END`, or end of file. Individual keyword folds nest inside their section so
you can collapse whole sections at once or drill in one keyword at a time.

### Align Record Columns

Tidy up record blocks so every column lines up. Invoke **OPM Flow: Align Record Columns**
from the Command Palette or the editor right-click menu. With a selection it aligns only
the selected lines; without one it aligns the whole document.

Groups of consecutive record lines (same token count) are reformatted in place:
strings left-aligned, integer columns right-aligned, and float columns aligned
on the decimal point (integers and `N*` repeat markers in a float column line
up at the decimal point position). Keyword headers, comment lines, the closing
`/`, and trailing `-- comments` are left untouched.

`--` comment lines interspersed within a record group no longer break the group —
every data line above and below the comment is aligned against a single shared set
of column widths.

If a `--` comment line immediately precedes a record group, the columns are aligned
to the word positions in that comment, so the data lines up under the headings.

Before:
```
MULTIPLY
 'PERMZ' 0.2 1 24 1 62 1 1 /
 'PERMZ' 0.04 1 24 1 62 2 2 /
 'PERMZ' 0.016 1 24 1 62 18 18 /
 'PERMZ' 1 1 24 1 62 22 22 /
/
```

After:
```
MULTIPLY
 'PERMZ' 0.2   1 24 1 62  1  1 /
 'PERMZ' 0.04  1 24 1 62  2  2 /
 'PERMZ' 0.016 1 24 1 62 18 18 /
 'PERMZ'     1 1 24 1 62 22 22 /
/
```

### Add Column Headers

Invoke **OPM Flow: Add Column Headers** from the Command Palette or the right-click menu
to insert a `--` comment above the record group with parameter names taken from the
keyword documentation, then align the records to those positions.

If a heading comment already exists it is updated in place. Running the command
multiple times is idempotent.

Example — cursor anywhere inside the `VFPIDIMS` record:
```
VFPIDIMS
-- MXMFLO MXMTHP MXVFPTAB
      30     20       20 /
```

### Toggle Line Comment

Select one or more lines and invoke **OPM Flow: Toggle Line Comment** (bound to
`Ctrl+/`, or `Cmd+/` on macOS — VS Code maps this to the same physical key as the
built-in comment toggle, so it follows your keyboard layout) — also available from
the right-click menu — to
add or remove a `--` comment marker at the very start of each selected line. If
every non-blank line in the selection is already commented the marker is
removed; otherwise `-- ` is inserted at column 0 of each line. Blank lines are
left untouched.

```
-- WCONPROD
--   'PROD' 'OPEN' /
```

### File Navigation (INCLUDE / IMPORT / RESTART / GDFILE)

Quoted file paths on `INCLUDE`, `IMPORT`, `RESTART`, and `GDFILE` statements
become clickable document links. Hold `Ctrl` (or `Cmd` on macOS) and click the
path — or right-click and choose **Go to Definition** — to open the referenced
file. Paths are resolved relative to the including file's directory, and any
`PATHS` aliases (`$NAME` lookups) defined in the deck are expanded before the
file is resolved.

```
INCLUDE
  'grid/PERM.inc' /
```

### Generate Keyword Reference

**OPM Flow: Generate Keyword Reference** (Command Palette `Ctrl+Shift+P`) opens a
Markdown document listing all keywords grouped by section — useful for uploading
as context to an AI chat session.

## Settings

Configure via **File → Preferences → Settings** and search for `opm-flow`,
or edit `settings.json` directly. All settings are scoped per-resource so
you can override them per-workspace or per-folder.

### Diagnostics

| Setting | Default | Description |
| --- | --- | --- |
| `opm-flow.diagnostics.excludedKeywords` | `["RPTSCHED"]` | Keywords to skip in every diagnostic check. Names are upper-cased on read; matching is case-insensitive. Add keywords whose record bodies don't fit the generic model and produce noisy false positives. |

### File associations

| Setting | Default | Description |
| --- | --- | --- |
| `opm-flow.additionalFileExtensions` | `[]` | Extra file extensions (with or without a leading `.`) to open as OPM Flow on top of the built-in list. Useful for project-specific include-file conventions. Matched case-insensitively. Example: `[".myinc", "wellconv"]`. For one-off cases the VS Code-native `files.associations` setting still works too. |

### Completion

| Setting | Default | Description |
| --- | --- | --- |
| `opm-flow.completion.stringValueStyle` | `"quoted"` | How STRING-typed parameter values appear in the suggestion list. `"quoted"` shows only `'OPEN'`; `"unquoted"` shows only `OPEN`; `"both"` shows each option twice (e.g. `OPEN` and `'OPEN'`). Inside an existing quoted token only the quoted form is offered regardless of this setting. |

### Docs sidebar and hover columns

These toggles control which columns appear in the keyword docs sidebar
and hover tooltips. Disabling unused columns gives the parameter table
more horizontal room in narrow side panels.

| Setting | Default | Description |
| --- | --- | --- |
| `opm-flow.columns.showType` | `true` | Show the parameter Type column (value type and dimension). |
| `opm-flow.columns.showDefault` | `true` | Show the Default column. |
| `opm-flow.units.showField` | `true` | Show the Field unit column. |
| `opm-flow.units.showMetric` | `true` | Show the Metric unit column. |
| `opm-flow.units.showLab` | `true` | Show the Laboratory unit column. |

## Supported File Extensions

The extension activates for the following extensions (case-sensitive on some platforms —
both common casings are registered where relevant):

Core deck files: `.data`, `.DATA`, `.dat`, `.inc`, `.INC`, `.incl`, `.include`,
`.sch`, `.SCH`, `.sched`, `.schedule`, `.summary`, `.smry`, `.grdecl`, `.GRDECL`,
`.grid`, `.gridopts`, `.vfp`, `.VFP`, `.vfpprod`, `.prop`, `.prpecl`, `.Ecl`, `.ecl`.

Section data files (Eclipse/OPM include conventions): `.aqucon`, `.aqunum`, `.dimens`,
`.eqldims`, `.eqlnum`, `.equil`, `.fault`, `.faults`, `.fipnum`, `.fipzon`, `.multnum`,
`.multregp`, `.multregt`, `.nnc`, `.ntg`, `.opernum`, `.perm`, `.permx`, `.poro`, `.pvt`,
`.pvtnum`, `.regdims`, `.rocknum`, `.rxvd`, `.satnum`, `.sattab`, `.swatinit`, `.tabdims`,
`.thpres`, `.trans`.

For project-specific extensions not covered by this list, set
`opm-flow.additionalFileExtensions` (see [Settings](#settings)).

## Language ID

The language is registered as `opm-flow`.

## Requirements

- VS Code 1.74.0 or later
- Python 3.10+ with `lxml` (only required when regenerating the keyword index)

## Release Notes

### 0.6.4

- **Issue #13** — Unquoted string values like `YES` under `SCALECRS` or
  `THPRES` under `EQLOPTS` are no longer mis-classified as keywords. The
  grammar is anchored to column 1; the analyzer treats indented keyword-
  shaped tokens inside an open record block as record values; cursor-driven
  docs/hover require the word to start at column 0 before treating it as a
  keyword declaration.
- **Bare uppercase tokens inside records** are now coloured as strings.
  Well/group/property names like `OP01`, `FIELD`, `UPPER`, `SGL`/`SOWCR` in
  `EQUALS`/`GRUPTREE`/`WCONHIST` records no longer pick up the keyword colour.
  The `keywords` rule was tightened to match only when the line is the keyword
  alone (optionally followed by a `--` comment or a `/`).
- **Multi-line records no longer false-flag as missing `/`**:
  - `MESSAGES` 13-INT records split as print-limits then stop-limits.
  - `VFPPROD` / `VFPINJ` axis (LIQ/THP/WFR/GFR/ALQ) and BHP tables; the block
    no longer demands a closing standalone `/` either.
  - `WOPR`, `WGPR` and 976 other non-F SUMMARY mnemonics with names spread
    across multiple lines.
- **Bare-stacked SUMMARY mnemonics** like `GMWPR \n GMWIN \n /` are accepted
  (new `optional_body` shape tagged on 981 non-F mnemonics so empty bodies
  don't demand a closing `/`; once values are listed the diagnostic still
  fires).
- **Keyword recognition** broadened:
  - SUMMARY-section mnemonics (`FOPR`, `WOPR`, `GGOR`, `GPR`, …).
  - Templated tracer mnemonics (`FTPRSEA`, `WTITHTO`, …) and TVDP mnemonics
    (`TVDPFWT1`, `TVDPSIGS`, …) resolved via base-name + suffix lookup.
  - OPM Flow Performance mnemonics (`TCPUDAY`, `ELAPSED`, …) and Control
    Mode Reporting mnemonics (`FMCTP`, `WSTAT`, …).
  - User-defined FIP region keywords (`FIPZON`, `FIPGL`, `FIPNL`, `FIPUNIT`,
    `FIPHC`, …).
  - UDQ SUMMARY mnemonics (`WUWI1`, `FUOIL`, `GUTOT`, …) via 2-char scope-
    prefix templates (`FU`, `WU`, `GU`, `CU`, `RU`, `SU`).
- **File links** extended from `INCLUDE` only to also cover `IMPORT`,
  `RESTART`, and `GDFILE`. `PATHS` aliases (`$NAME` lookups) are expanded
  before resolution.
- **Variadic-record keyword continuation lines** (`RSVD`, `RVVD`, `PVDO`,
  `PVTO`) no longer flagged as missing per-record `/`.
- **`TITLE`** no longer requires a trailing `/`.
- **Multi-record keywords with integer size** (`TUNING`, `TUNINGL`, `TUNINGS`,
  `PLYSHLOG`, `PRORDER`, `PYACTION`) are classified as `fixed`, not `list`, so
  no spurious closing-`/` warning.
- **17 additional file extensions** registered: `.dat`, `.eqldims`,
  `.faults`, `.fipzon`, `.grid`, `.gridopts`, `.incl`, `.permx`, `.prpecl`,
  `.pvtnum`, `.regdims`, `.rxvd`, `.sched`, `.smry`, `.swatinit`, `.trans`,
  `.vfpprod`.
- **New `opm-flow.additionalFileExtensions` setting** for project-specific
  include-file extensions not covered by the built-in list. Resource-scoped so
  a workspace can pin its own list.

### 0.6.3

- New diagnostic: keyword not starting in column 1. Per the OPM Flow
  reference manual, indented keywords are silently ignored by the simulator.
- New diagnostic: keyword in non-uppercase form. Lines shaped like a
  keyword declaration whose upper-cased form is a recognised keyword
  are flagged because OPM Flow only accepts uppercase keywords.
- Hover on a keyword that is on the diagnostics exclusion list
  (`opm-flow.diagnostics.excludedKeywords`) now shows a notice explaining
  that arity, terminator, and section checks are skipped for that keyword.
- New `opm-flow.completion.stringValueStyle` setting controls how
  STRING-typed parameter values appear in completions: `quoted` (default),
  `unquoted`, or `both`.
- Free-form text after a record-terminating `/` is now treated as a
  trailing comment (the `--` prefix is no longer required).
- Bare uppercase identifiers inside an open record block are recognised as
  unquoted string values rather than flagged as unknown keywords (e.g. an
  `INCLUDE` followed by an unquoted path on the next line).

### 0.6.2

- Multi-record keyword support: hover, docs panel and arity diagnostics
  resolve the parameter against the record the cursor is in for keywords
  like `WELSEGS`, `VFPPROD`, `COMPSEGS`, `ACTIONX`, `TUNING`.
- Diagnostics extended to flag unknown keywords, missing per-record `/`
  terminators, and missing closing `/` on record-list and array blocks.
- New `opm-flow.diagnostics.excludedKeywords` setting to silence
  diagnostics for keywords whose record bodies don't fit the generic model.
- New column-toggle settings (`opm-flow.columns.*`, `opm-flow.units.*`)
  to hide unused columns in the docs sidebar and hover tooltips.
- Keyword data merged from the `opm-common` submodule, with corrected
  arity classification.
- Recover keywords with duplicate `xml:id` from the manual and parse
  dual-name PVT parameter rows.