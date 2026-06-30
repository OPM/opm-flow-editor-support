# Video capture script — OPM Flow editor support

Shot-by-shot script for recording short demo clips of the extension. Each
**Take** is a self-contained clip (~15–45 s). Record them separately so they can
be trimmed and reordered later.

## Setup (do this once, off-camera)

1. Install the extension (Marketplace, or `Install from VSIX…`).
2. Disable any conflicting E100/E300 deck extension so `.DATA` files bind to
   this one.
3. Open the `demo-decks/` folder in VS Code (`File → Open Folder…`).
4. Recommended look: a dark theme, editor font ~16 px, zoom level +1
   (`Ctrl+=` once), minimap off, breadcrumbs on.
5. Hide personal panels; keep the Explorer visible on the left.

Pacing tips: move the cursor deliberately, pause ~1 s on each tooltip so it is
readable, and let folds/alignments settle before cutting.

---

## Clip 1 — First impressions (file `01-spe1-basics/SPE1CASE1.DATA`)

**Goal:** show that a deck "comes alive" the moment it opens.

- **Take 1 — Syntax highlighting.** Open the file. Scroll slowly top to bottom.
  Call out section headers (`RUNSPEC`, `GRID`, `PROPS`, `SCHEDULE`), keywords,
  comments, numbers, the `300*1000` repeat marker, and `/` record terminators
  all colored distinctly.

- **Take 2 — Hover tooltips.** Hover the keyword `WELSPECS` (in `SCHEDULE`).
  The tooltip shows the valid sections, a summary, the parameter table, and an
  example. Then hover `COMPDAT`, then `WCONPROD`. Finally hover a *value* inside
  the `WCONPROD` record (e.g. `ORAT`) — the tooltip resolves to the matching
  parameter column.

- **Take 3 — Docs sidebar.** Open the OPM Flow docs panel and click into a few
  keywords. The panel follows the cursor and highlights the active parameter
  row. Move the cursor across the `WELSPECS` record items to show the row
  highlight tracking the column.

- **Take 4 — Folding.** In the gutter, fold the `PROPS` section (collapses to
  the next section keyword), then unfold. Then fold an individual keyword block
  such as `SWOF`. Show section-level and keyword-level folding.

- **Take 5 — Completion.** At the end of `SCHEDULE`, on a new line in column 1,
  type `WCON` — the keyword completion list appears with sections and one-line
  summaries. Then inside a fresh `COMPDAT` record, at the STATUS column, trigger
  completion to show the value list (`OPEN` / `SHUT` / `AUTO`). *(Undo any typing
  before the next take with `Ctrl+Z`.)*

- **Take 6 — Align Record Columns.** Put the cursor inside the `SWOF` table (or
  the `WELSPECS` block). Run **OPM Flow: Align Record Columns** from the Command
  Palette (`Ctrl+Shift+P`). Columns snap into alignment. Show the before/after.

- **Take 7 — Add Column Headers.** With the cursor in the `COMPDAT` block, run
  **OPM Flow: Add Column Headers**. A `--` comment with parameter names is
  inserted and the rows align to it. Re-run once to show it is idempotent.

- **Take 8 — Generate Keyword Reference.** Run **OPM Flow: Generate Keyword
  Reference**. A Markdown document opens listing keywords grouped by section.
  Scroll briefly. *(Good closing shot — "use this as AI-chat context".)*

---

## Clip 2 — Diagnostics (file `01-spe1-basics/SPE1CASE1.DATA`)

**Goal:** show the squiggles that catch real deck mistakes. Make small edits on
camera, then `Ctrl+Z` each one back.

- **Take 1 — Unknown keyword.** Type a misspelled keyword in column 1, e.g.
  `WELSPESC`. A red squiggle appears; hover to read "unrecognised keyword".

- **Take 2 — Wrong section.** Copy `WELSPECS` up into `GRID`. Squiggle flags a
  keyword placed in the wrong section.

- **Take 3 — Lowercase keyword.** Change `COMPDAT` to `compdat`. Squiggle flags
  the non-uppercase form that OPM Flow silently ignores.

- **Take 4 — Indented keyword.** Add a leading space before `WCONPROD`. Squiggle
  flags a keyword not starting in column 1.

- **Take 5 — Missing terminator.** Delete the trailing `/` on a `WELSPECS`
  record. Squiggle flags the missing per-record `/`.

Undo everything so the file is clean for the next session.

---

## Clip 3 — UDQ & ACTIONX (folder `02-udq-actionx/`)

**Goal:** show the editor understands OPM's UDQ / ACTIONX extensions.

- **Take 1 — UDQ alignment (`UDQ_WCONPROD.DATA`, `UDQ` block ~line 349).**
  Show the `UDQ` block with `DEFINE … / UNITS …` statements slightly ragged.
  Run **OPM Flow: Align Record Columns**. The dedicated three-column layout
  appears: control word and variable name left-aligned, expression right-aligned
  so every terminating `/` lines up. Point out that a `/` used as division inside
  an expression is **not** mistaken for the terminator.

- **Take 2 — UDQ hover & highlighting.** Hover `DEFINE` and a UDQ variable name.
  Show the keyword is recognised and highlighted (not flagged as unknown).

- **Take 3 — ACTIONX hover (`ACTIONX_M1.DATA`, `ACTIONX` blocks from ~line 385).**
  Hover the `ACTIONX` keyword to show its docs. Then place the cursor inside the
  condition record (e.g. `WBHP P1 < 200.0`) and show the hover/sidebar resolving
  parameters for the record the cursor is in.

- **Take 4 — Multi-record awareness.** Move the cursor between the ACTIONX
  header record and the nested action keyword (`WELOPEN`) and show the docs
  panel switching context per record.

---

## Clip 4 — Includes & name completion (folder `03-includes-and-names/`)

**Goal:** show project-aware navigation and completion.

- **Take 1 — Follow an INCLUDE (`TEST1_WS.DATA`).** `Ctrl+click` a quoted path
  on an `INCLUDE` statement (e.g. `'include/test1_20x30x10.grdecl'`). The
  referenced file opens in a new editor. Repeat with a `.inc` file
  (`relperm.inc`).

- **Take 2 — Well-name completion.** The deck declares wells in `WELSPECS`
  (`B-1H`, `B-2H`, `F-1H`, `F-2H`, `G-3H`, …) and groups in `GRUPTREE`
  (`PLAT-A`, `M5N`, `M5S`, `LP`, `C1`, `F1`, …). On a new `WELOPEN` line in
  `SCHEDULE`, start typing the well-name parameter and trigger completion — the
  list offers the names declared in the deck. `Ctrl+Z` afterward.

- **Take 3 — Group-name completion.** On a new `GCONPROD` line, trigger
  completion at the group-name column to show the `GRUPTREE` group names. Undo.

---

## Clip 5 — Multi-segment wells (folder `04-msw-multirecord/`)

**Goal:** show per-record handling for the trickiest multi-record keywords.

- **Take 1 — PATHS alias navigation (`MSW-SIMPLE.DATA`).** Show the `PATHS`
  keyword (~line 127) defining the `WSEGVALV` alias. `Ctrl+click` an
  `INCLUDE` path that uses `$WSEGVALV/…` (e.g. `'$WSEGVALV/grid1.grdecl'`) — the
  alias is expanded and the file opens.

- **Take 2 — WELSEGS per-record hover (`WELSEGS` ~line 434).** Hover the
  `WELSEGS` keyword for the header docs. Then move the cursor onto a segment row
  and show the hover resolving against the segment record (not the header).

- **Take 3 — Per-record column headers.** Put the cursor in a `WELSEGS` segment
  row and run **OPM Flow: Add Column Headers**. The inserted names come from the
  record the group belongs to (e.g. `ISEG1`, `ISEG2`, …). Repeat in the
  `COMPSEGS` block (~line 479) to show it adapts per keyword.

- **Take 4 — Align the segment table.** Run **Align Record Columns** on the
  `WELSEGS` segment block to tidy the long numeric rows.

---

## Suggested 60-second highlight reel (order of cuts)

1. Open `SPE1CASE1.DATA` → highlighting pan (Clip 1 / Take 1).
2. Hover `WELSPECS` tooltip (Clip 1 / Take 2).
3. Docs sidebar following the cursor (Clip 1 / Take 3).
4. One diagnostic squiggle + hover (Clip 2 / Take 1).
5. Align Record Columns before/after (Clip 1 / Take 6).
6. UDQ three-column alignment (Clip 3 / Take 1).
7. `Ctrl+click` INCLUDE jump (Clip 4 / Take 1).
8. Well-name completion list (Clip 4 / Take 2).
9. WELSEGS per-record headers (Clip 5 / Take 3).
10. Close on Generate Keyword Reference (Clip 1 / Take 8).
