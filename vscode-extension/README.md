# OPM Flow VS Code Extension

Language support for [OPM Flow](https://opm-project.org/) reservoir simulation deck files,
with syntax highlighting and development features backed by the full OPM Flow reference manual.

<!-- manual-ref:start -->
Keyword data is built from [OPM/opm-reference-manual](https://github.com/OPM/opm-reference-manual) at commit [`52fbb530`](https://github.com/OPM/opm-reference-manual/commit/52fbb5300fbe0e453f20244500211d8e88ded5ff).
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
- **UDQ / ACTIONX constructs**: UDQ control words (`DEFINE`, `ASSIGN`, `UNITS`,
  `UPDATE`), UDQ functions (`SORTA`, `SUM`, `ABS`, …), the comparison and
  logical operators used in expressions (`>=`, `<=`, `==`, `AND`, `OR`), and the
  `ACTIONX` / `ENDACTIO` action-block delimiters

### Keyword Autocompletion

Autocomplete support for OPM Flow keywords extracted from the reference manual.
Each completion item shows the deck section(s) the keyword is valid in
(`RUNSPEC`, `GRID`, `SCHEDULE`, …) and a one-line summary in the documentation
pane. Keywords that are valid in every section (e.g. `INCLUDE`, `ECHO`) list
them all. Completions are triggered when typing uppercase letters at the start
of a line.

Accepting a completion inserts the keyword together with a **boilerplate data
record** as a tab-navigable snippet: each parameter becomes a placeholder filled
with its documented default, or a type-appropriate dummy value when there is no
default (`1` for integers, `0.0` for reals, `'STRING'` for strings). The record
is terminated to match the keyword's shape — a single `/` for fixed and array
keywords, plus an extra standalone `/` line for record-list keywords like
`WELSPECS` and `COMPDAT`. Activation keywords (e.g. `OIL`, `UNIFOUT`) insert the
name alone. Press `Tab` to jump between placeholders and overwrite the dummy
values. To insert just the keyword name with no record, set
`opm-flow.completion.keywordInsert` to `keyword` (see [Settings](#settings)).

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

When the current column is a **well- or group-name** parameter — recognised by
the opm-common item name (the `WELL`/`GROUP` family and their spelling
variants, so `WCONPROD`, `WELOPEN`, `GCONPROD`, `WEFAC`, … all qualify) — the
list instead offers the names the deck already declares: well names from
`WELSPECS`, and group names from `WELSPECS` (the parent-group column) and
`GRUPTREE`. Names are gathered from the whole file, so opening a quote (`'`) or
pressing `Ctrl+Space` in a well column lists every well defined in the deck.
The `stringValueStyle` setting controls quoting just as it does for option
values.

### UDQ and ACTIONX Support

The user-defined-quantity sub-language (`UDQ` blocks) and `ACTIONX` action blocks
are recognised so the editor can assist with their distinct syntax:

- **Completion** — inside a `UDQ` block, the start of a statement offers the
  control words (`ASSIGN`, `DEFINE`, `UNITS`, `UPDATE`); inside a UDQ formula or
  an `ACTIONX` condition, the UDQ functions (`SORTA`, `SUM`, `ABS`, …) are
  offered and inserted with parentheses ready for the argument.
- **Hover** — hovering a UDQ control word shows what it does, and hovering a UDQ
  function shows its signature and description.
- **Diagnostics** — a `UDQ` statement that doesn't start with a control word, and
  an `ACTIONX` block left unclosed by `ENDACTIO`, are flagged (see
  [Diagnostics](#diagnostics)).

### Hover Tooltips

Hover over any keyword to see a quick tooltip with:

- The **keyword name and all valid sections**
- A **summary** from the reference manual
- A **parameter table** listing all record fields with units and defaults
- A usage **example**

Hovering over a **value in a data record** shows the description for that specific
parameter column. For example, hovering over the group name in a `WELSPECS` record
shows the `GRPNAME` parameter description, units, and default.

For a summary vector or array variant that derives from an `opm-common` keyword
family — e.g. `WOPR` (from `WELL_PROBE`) or `KRNUMX` (from `KRNUM`) — the hover
adds a *Deck-name alias of `<family>`* line, so you can see which keyword family
the concrete name belongs to.

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
- **Value-type mismatch** — a record value whose form is unambiguously wrong
  for the parameter's declared `value_type`, e.g. a quoted string in a numeric
  slot or a decimal in an integer slot. Deliberately conservative: bare
  identifiers (which may be UDA/UDQ references) and enum-option mismatches are
  never flagged, and defaults (`*`, `N*`) are always accepted.
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
- **Missing required keyword** — a keyword whose `requires` partner (from
  `opm-common`) is absent, e.g. a saturation-function table without its phase
  keyword. Suppressed when the deck pulls in other files via
  `INCLUDE`/`IMPORT`/`GDFILE` (the partner may live there) or has no section
  header (an include fragment, not a complete deck).
- **Mutually exclusive keywords** — two keywords that `opm-common` marks as
  `prohibits` partners both appearing in the same deck.
- **UDQ statement without a control word** — a statement inside a `UDQ` block
  that does not begin with `ASSIGN`, `DEFINE`, `UNITS`, or `UPDATE`.
  Continuation lines of a statement whose `/` is deferred are not flagged.
- **Unclosed `ACTIONX` block** — an `ACTIONX` action block with no matching
  `ENDACTIO` before the end of the deck.

Keywords whose record bodies don't fit the generic model can be silenced
wholesale via the `opm-flow.diagnostics.excludedKeywords` setting — see
[Settings](#settings) below.

### Quick Fixes

Diagnostics that have an unambiguous correction offer a lightbulb **Quick Fix**
(`Ctrl+.`, or `Cmd+.` on macOS). Place the cursor on the squiggle, open the
lightbulb, and apply:

- **Convert to uppercase** — a lowercase keyword like `welspecs` → `WELSPECS`.
- **Move keyword to column 1** — strip the leading whitespace from an indented
  keyword.
- **Add terminating `/`** — append the missing per-record `/`.
- **Add `/` to close the record list / value array** — insert the missing
  standalone `/` line that closes a `WELSPECS`/`COMPDAT` block or a
  `PORO`/`PERMX` array.
- **Replace with `<nearest>`** — for an unrecognised keyword that is a close typo
  of a known one (e.g. `EQLDIM` → `EQLDIMS`), substitute the suggested keyword.

### Docs Panel (Sidebar)

Open the **Explorer** sidebar (`Ctrl+Shift+E`) and scroll down to the **OPM Keyword Reference** panel.
It updates automatically as you move the cursor — no keystrokes needed:

- **Cursor on a keyword** → full documentation: valid sections, summary, complete parameter table, example
- **Cursor on a value column** → same view with the matching parameter row highlighted
- **Cursor on whitespace or a comment** → panel retains the last shown keyword

The panel shows the keyword name, the section(s) it applies to, the summary,
the parameter table, and the example. This is the main view for reading long
keyword documentation, since it scrolls freely and stays visible while you edit.

By default each parameter's **Type, units, and Default** are folded into a
compact muted sub-line beneath its description (the **embedded** layout). This
keeps the Description readable even for keywords with many parameters (e.g.
`WECON`), where a wide column grid otherwise squeezes it into a sliver. Set
`opm-flow.docs.layout` to `columns` to restore the original separate-column
table; the per-column show/hide settings (see [Settings](#settings)) still apply
in either layout.

### Keyword Outline (Tree View)

The **OPM Flow Outline** panel in the Explorer sidebar shows the deck as a
two-level tree — each section (`RUNSPEC`, `GRID`, `EDIT`, `PROPS`, `REGIONS`,
`SOLUTION`, `SUMMARY`, `SCHEDULE`) with its keywords nested underneath. Click any
keyword to jump straight to it in the editor; the tree selection also follows the
cursor as you move through the deck, and the view tracks the active file.
Sections are collapsible, so you can fold away the parts of a large deck you are
not working on. Each node carries the keyword summary as a tooltip.

### Collapse Sections and Keywords

Sections and individual keywords can be folded in the editor gutter. A section
runs from a section keyword (`RUNSPEC`, `GRID`, `EDIT`, `PROPS`, `REGIONS`,
`SOLUTION`, `SUMMARY`, `SCHEDULE`) until the next section keyword,
`END`, or end of file. Individual keyword folds nest inside their section so
you can collapse whole sections at once or drill in one keyword at a time.

### Align Record Columns

Tidy up record blocks so every column lines up. Three levels are available from the
Command Palette or the editor right-click menu, depending on how much you want to touch:

- **OPM Flow: Align Record Columns in Record** — aligns only the record group under
  the cursor.
- **OPM Flow: Align Record Columns in File** — aligns the whole current file, or just
  the selected lines when there is a selection.
- **OPM Flow: Align Record Columns in Deck** — follows the `INCLUDE` chain and aligns
  every reachable file (see below).

Groups of consecutive record lines (same token count) are reformatted in place:
strings left-aligned, integer columns right-aligned, and float columns aligned
on the decimal point (integers and `N*` repeat markers in a float column line
up at the decimal point position). Keyword headers, comment lines, the closing
`/`, and trailing `-- comments` are left untouched.

`--` comment lines interspersed within a record group no longer break the group —
every data line above and below the comment is aligned against a single shared set
of column widths.

Comments are ignored when aligning: columns are positioned from the record data
alone, and any comment lines (whether above or within the group) are left exactly
as they are. A descriptive comment above a table is never mistaken for a column
heading.

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

#### Align across the whole deck

**OPM Flow: Align Record Columns in Deck** starts from the active document,
follows every `INCLUDE` (resolving `PATHS` aliases) recursively, and aligns the
record tables in all reachable files in one operation. It reports how many lines
and files were changed when it finishes.

When sweeping the whole deck, per-cell grid/region/solution arrays (`PORO`, `PERMX`,
`COORD`, `SATNUM`, …) and large tables (`VFPPROD`/`VFPINJ`) are skipped by default so
an `INCLUDE`d grid file is not silently rewritten and its deliberate fixed-width layout
is preserved. The **in Record** and **in File** commands do *not* apply these defaults —
when you align text you explicitly targeted, everything is aligned.

Add further keywords to skip via `opm-flow.formatting.alignColumnsExcludedKeywords`
(honoured by all three commands, and *added* to the deck defaults).

### Add Column Headers

Invoke **OPM Flow: Add Column Headers** from the Command Palette or the right-click menu
to insert a `--` comment above the record group with parameter names taken from the
keyword documentation, then align the records to those positions.

Existing comments around the table are ignored, so a descriptive comment above the
data is never mistaken for a heading. If the line directly above the group is a
heading this command previously generated (its words are exactly the column names),
it is updated in place; otherwise a new heading line is inserted. Running the command
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

### Open PRT File

With a `.DATA` deck open, **OPM Flow: Open PRT File** opens the matching
`<CASE>.PRT` print/output file from the same folder — the file OPM Flow writes
after a run. It is available from the editor right-click menu, the Command
Palette, or the `Ctrl+Alt+P` (`Cmd+Alt+P` on macOS) shortcut. If the deck has
not been run yet and no `.PRT` exists beside it, a notice is shown.

### Verify and Run the Simulation (optional)

When a local OPM Flow binary is configured, two commands let you act on the open
deck without leaving the editor — both available from the editor right-click menu
and the Command Palette:

- **OPM Flow: Verify Deck (dry run)** runs flow in dry-run mode. The deck is
  fully parsed and the model is initialized (grid, properties, wells, schedule),
  but the time steps are not simulated — a fast check that the deck and
  everything it pulls in via `INCLUDE` / `PATHS` loads cleanly.
- **OPM Flow: Run Simulation** runs the full simulation.

Both run in an integrated terminal, started in the deck's own directory so its
relative paths resolve. The output appears live, and afterwards
[Open PRT File](#open-prt-file) shows the print file.

This is opt-in: nothing runs until you set `opm-flow.simulator.executablePath`
(see [Simulator](#simulator) under Settings). On **Windows**, OPM Flow is
typically installed inside WSL — enable `opm-flow.simulator.useWsl` and point the
executable path at the Linux binary (e.g. `/usr/bin/flow`); the deck's Windows
path is translated to its `/mnt/<drive>` mount automatically.

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

### Simulator

Optional integration for the [Verify and Run](#verify-and-run-the-simulation-optional)
commands. Leave `executablePath` unset to keep the feature dormant.

| Setting | Default | Description |
| --- | --- | --- |
| `opm-flow.simulator.executablePath` | `"flow"` | Path to the OPM Flow executable. With `useWsl` enabled this is a path *inside* WSL (e.g. `/usr/bin/flow`); otherwise a native path or a name on `PATH`. |
| `opm-flow.simulator.useWsl` | `false` | Run flow through WSL (`wsl.exe`). Required on Windows. The deck's Windows path is translated to its `/mnt/<drive>` mount automatically. |
| `opm-flow.simulator.wslDistribution` | `""` | WSL distribution to use (e.g. `ubuntu-26.04`); empty uses the default. List installed distributions with `wsl -l -v`. Only used when `useWsl` is enabled. |
| `opm-flow.simulator.verifyArgs` | `["--enable-dry-run=true"]` | Arguments for **Verify Deck**. The default parses and initializes the model without simulating time steps. Add `--parsing-strictness=high` to also fail on unsupported keywords. |
| `opm-flow.simulator.runArgs` | `[]` | Extra arguments for **Run Simulation** (e.g. `--output-dir=...`, `--threads-per-process=4`). The deck file is supplied automatically. |

### Completion

| Setting | Default | Description |
| --- | --- | --- |
| `opm-flow.completion.keywordInsert` | `"template"` | What accepting a keyword completion inserts. `"template"` adds the keyword plus a boilerplate data record (typed placeholders / documented defaults) as a tab-navigable snippet; `"keyword"` inserts just the keyword name. |
| `opm-flow.completion.stringValueStyle` | `"quoted"` | How STRING-typed parameter values appear in the suggestion list. `"quoted"` shows only `'OPEN'`; `"unquoted"` shows only `OPEN`; `"both"` shows each option twice (e.g. `OPEN` and `'OPEN'`). Inside an existing quoted token only the quoted form is offered regardless of this setting. |

### Docs layout

| Setting | Default | Description |
| --- | --- | --- |
| `opm-flow.docs.layout` | `"embedded"` | How the docs sidebar and hover tooltips lay out parameter metadata. `"embedded"` folds Type, units, and Default into a compact sub-line beneath each description (more room for the description); `"columns"` renders them as separate table columns (the original layout). The show/hide settings below apply in either layout. |

### Docs sidebar and hover columns

These toggles control which Type, unit, and Default values appear in the keyword
docs sidebar and hover tooltips — as columns in the `columns` layout, or as bits
of the metadata sub-line in the `embedded` layout. Disabling unused values gives
the description more horizontal room in narrow side panels.

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

### Unreleased

- **Verify and run the simulation (optional)** — new **OPM Flow: Verify Deck
  (dry run)** and **OPM Flow: Run Simulation** commands launch a locally
  installed `flow` binary on the open deck in an integrated terminal. Verify uses
  flow's dry-run mode to confirm the deck (and its `INCLUDE` / `PATHS` files)
  loads without solving. Configure via the new `opm-flow.simulator.*` settings;
  Windows users can target a WSL distribution, with deck paths translated to
  `/mnt/<drive>` automatically.
- **UDQ and ACTIONX support** — the `UDQ` expression sub-language and `ACTIONX`
  action blocks are now recognised. Syntax highlighting scopes UDQ control
  words, UDQ functions, and expression operators, plus the `ACTIONX` /
  `ENDACTIO` block delimiters. Hover and completion cover UDQ control words and
  functions, and two new diagnostics flag a UDQ statement that doesn't start
  with a control word and an `ACTIONX` block left unclosed by `ENDACTIO`.
  Column alignment also gives `UDQ` expression blocks a dedicated three-column
  layout (control word, variable, expression) that treats a `/` used for
  division as part of the expression rather than the record terminator.
- **Boilerplate keyword completion** — accepting a keyword completion now inserts
  a sample data record as a tab-navigable snippet (documented defaults or
  type-appropriate dummy values, terminated to match the keyword's shape) instead
  of just the keyword name. The new `opm-flow.completion.keywordInsert` setting
  switches back to name-only insertion.
- **Diagnostic quick fixes** — lightbulb fixes for common deck mistakes:
  uppercase a lowercase keyword, move an indented keyword to column 1, add a
  missing record / list / array terminator `/`, and replace an unrecognised
  keyword with its nearest known match.
- **Value-type diagnostic** — record values are now checked against each
  parameter's declared `opm-common` type; an unambiguous mismatch (a quoted
  string in a numeric slot, a decimal in an integer slot) is flagged, while
  bare identifiers and enum-option mismatches are left alone to avoid false
  positives.
- **Cross-keyword `requires` / `prohibits` diagnostics** — flags a keyword whose
  required partner is missing from the deck, and a pair of mutually-exclusive
  keywords that both appear. The `requires` check is suppressed for
  include-based decks and bare include fragments.
- **Fewer false positives on valid decks** — broadened keyword recognition and
  relaxed terminator rules, validated against the
  [OPM/opm-tests](https://github.com/OPM/opm-tests) corpus:
  - More SUMMARY vectors are recognised rather than flagged as unknown
    keywords: PROBE `deck_name`s, directional `KRNUM`/`IMBNUM` region variants,
    L-modifier vectors (`WOPRL`, `LWWIR`), FIP region-set vectors (`ROIP_ABC`),
    UDQ names (`WUOPRL`, `FU_VAR1`), and resolved `deck_name` aliases.
  - Variadic-record list keywords (`VFPPROD`, `VFPINJ`, `RSVD`) no longer
    require a separate closing `/`.
  - The missing-record-terminator check is deferred until a record is actually
    left unterminated, so a `/` placed on a later line is accepted.
  - The wrong-section check is suppressed after an `INCLUDE`, whose file may
    supply the section header.
  - An indented unknown token under an active keyword is treated as record body
    rather than flagged as an unknown keyword.
- **Deck-name alias resolution** — concrete summary vectors and directional
  array variants now record which `opm-common` keyword family they derive from
  (e.g. `WOPR` → `WELL_PROBE`, `KRNUMX` → `KRNUM`) and surface it in hover. The
  31 family/container schema names themselves (`WELL_PROBE`,
  `AQUIFER_PROBE_ANALYTIC`, `MULT_XYZ`, …) are no longer offered as completions
  or accepted as valid keywords, since they are never typed in a deck.

### 0.8.0

- **Keyword outline tree view** (Issue #41) — a new **OPM Flow Outline** panel in
  the Explorer shows sections and their keywords as a navigable, collapsible
  tree. Click a keyword to jump to it in the editor; the selection follows the
  cursor and the view tracks the active file.
- **Compact parameter docs layout** (Issue #26) — parameter Type, units, and
  Default are now folded into a muted sub-line beneath each description (the new
  default `embedded` layout), giving long descriptions far more room in the docs
  sidebar and hover tooltips. Set `opm-flow.docs.layout` to `columns` to keep the
  previous separate-column table.
- **Open PRT file** (Issue #44) — open the matching `<CASE>.PRT` print file next
  to a `.DATA` deck from the editor right-click menu, the Command Palette, or the
  new `Ctrl+Alt+P` (`Cmd+Alt+P` on macOS) shortcut.
- **Section headers with trailing separators** (Issue #31) — a decorated section
  line such as `GRID ==============` is now recognised as a section header, so
  keywords after it are no longer wrongly flagged "not valid in RUNSPEC" and
  section folds still open correctly.
- **Dependency and CI maintenance** — routine dev-dependency and GitHub Actions
  updates.

### 0.7.1

- **Toggle line comment** (Issue #27) — comment/uncomment the current line or
  selection with the standard editor shortcut, using OPM Flow's `--` comment
  syntax.
- **Refreshed keyword data** — the bundled OPM Flow reference manual and
  `opm-common` keyword definitions were updated to their latest upstream
  revisions, broadening keyword coverage, section validity, and per-parameter
  value-type/dimension information surfaced in hover and the docs sidebar.
- **Security hardening** — CI workflow permissions and action pinning, plus
  webview/hover and policy hardening.

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