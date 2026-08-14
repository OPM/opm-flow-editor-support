# opm-flow-editor-support

VS Code extension providing editor support for OPM Flow simulation deck files,
backed by the full [OPM Flow reference manual](https://github.com/OPM/opm-reference-manual).

**Browse the keyword reference online:** <https://opm.github.io/opm-flow-editor-support/> —
every OPM Flow keyword with its sections, summary, description, parameters and
examples, searchable, no install required.

## Install

### From the VS Code Marketplace

1. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **OPM Flow** and click **Install**.

Or from the command palette: `ext install magne-sjaastad.opm-flow-editor-support`.

Marketplace listing: <https://marketplace.visualstudio.com/items?itemName=magne-sjaastad.opm-flow-editor-support>

### From a GitHub Release

1. **Download the `.vsix` file** from the [Releases page](https://github.com/OPM/opm-flow-editor-support/releases/latest).
   Look for a file named `opm-flow-editor-support-<version>.vsix` under the release assets.

2. **Open VS Code.**

3. **Open the Extensions view** — press `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (macOS),
   or click the Extensions icon in the Activity Bar on the left.

4. **Open the extension menu** — click the `⋯` (three-dot) button at the top-right corner
   of the Extensions panel.

5. **Choose "Install from VSIX…"** from the dropdown.

6. **Browse to the downloaded `.vsix` file** and click **Install**.

7. VS Code will install the extension and prompt you to reload the window.
   Click **Reload Window** (or press `Ctrl+Shift+P` → `Reload Window`).

8. **Verify**: Open any `.data` or `.sch` file. Keywords should be highlighted, and
   hovering over a keyword should show its documentation tooltip.

> **Note 1:** If you previously installed the extension, VS Code may ask whether to replace
> the existing version. Confirm to upgrade.

> **Note 2:** If another extension is registered for the same simulator deck file types, it
> may take precedence over this one — for example the E100/E300 extension listed
> under [References](#references). Disable or uninstall the conflicting extension
> if you want the features in the OPM Flow plugin to apply to `.data`/`.DATA`/`.inc`/`.INC` files.


## Features

- **Syntax highlighting** for section headers, keywords, comments, record
  terminators, numbers, repeat markers, and template variables.
- **Keyword autocompletion** for OPM Flow keywords (including OPM-specific
  extensions like `PYACTION`), with every valid section and a one-line
  summary shown inline.
- **Value autocompletion** inside records: when the parameter at the
  current column has known string options (e.g. `OPEN`/`SHUT`/`AUTO`
  for `COMPDAT` STATUS), the suggestion list shows them.
- **Well / group name completion**: when the current column is a well- or
  group-name parameter (e.g. the first item of `WCONPROD`, `WELOPEN`,
  `GCONPROD`), the suggestion list offers the names the deck declares in
  `WELSPECS` and `GRUPTREE`.
- **Hover tooltips** showing all valid sections for the keyword, a summary,
  parameter table (with parameter type and dimension where known), and
  example. Hovering over a value in a data record shows the matching
  parameter column. For multi-record keywords (`WELSEGS`, `VFPPROD`,
  `COMPSEGS`, `ACTIONX`, `TUNING`, …) the hover resolves the parameter
  against the record the cursor is in.
- **Diagnostics** — squiggles flag unrecognised keywords, keywords placed in
  the wrong section (e.g. `WELSPECS` outside `SCHEDULE`), records with too
  many values (per-record arity for multi-record keywords; the message
  names which record overflowed), missing per-record `/` terminators,
  missing closing `/` on record-list and cell-property-array blocks,
  keywords not starting in column 1, and keywords typed in non-uppercase
  form — both of which OPM Flow itself silently fails to recognise.
- **Docs panel** that follows the cursor — full documentation for the
  keyword under the cursor, with the active parameter row highlighted.
  Multi-record keywords are rendered as one parameter table per record
  with a heading per record.
- **Collapsible sections and keywords** — fold section blocks (from one
  section keyword to the next) or individual keywords in the gutter.
- **Align Record Columns** — tidy up record blocks so every column lines up;
  handles comment lines inside the group and aligns to heading comments above
  the group. `UDQ` expression blocks get a dedicated three-column layout —
  the control word (`DEFINE`/`ASSIGN`/`UNITS`/`UPDATE`) and the variable name
  both left-aligned, and the expression right-aligned so every statement's
  terminating `/` lines up (a `/` used for division inside the expression is
  not mistaken for the terminator).
- **Add Column Headers** — insert a `--` heading comment with parameter names
  from the reference manual and align the record group to those positions
  (idempotent). For multi-record keywords the names come from the record
  the group belongs to (e.g. `ISEG1`, `ISEG2`, … for a `WELSEGS` segment row).
- **File navigation** — `Ctrl+click` a quoted path on `INCLUDE`, `IMPORT`,
  `RESTART`, or `GDFILE` statements to open the referenced file. `PATHS`
  aliases (`$NAME` lookups) are expanded before the file is resolved.
- **Verify and run the simulation** (optional) — with a local OPM Flow binary
  configured, **Verify Deck (dry run)** parses and initialises the deck without
  solving (a fast check that it and its `INCLUDE`/`PATHS` files load cleanly),
  and **Run Simulation** runs the full case, both in an integrated terminal. On
  Windows the simulator runs through WSL, with deck paths translated to their
  `/mnt/<drive>` mount automatically.
- **Generate Keyword Reference** — opens a Markdown document listing all
  keywords grouped by section, useful for uploading as AI-chat context.

## References

- [equinor/vscode-lang-e100e300](https://github.com/equinor/vscode-lang-e100e300) — VS Code language extension for Eclipse E100/E300 decks
- [Pyrus Suite](https://pkirkham.github.io/pyrus/) — Peter Kirkham's free toolkit of oil & gas technical tools, including an ECLIPSE deck editor and OPM Flow integration. Peter Kirkham has contributed valuable feedback and suggestions to this extension.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for repo layout, clone/build instructions,
how to regenerate the keyword index, and the release process.

## License

[GPL-3.0-only](LICENSE).
