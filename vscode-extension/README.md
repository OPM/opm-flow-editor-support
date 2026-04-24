# OPM Flow VS Code Extension

Language support for [OPM Flow](https://opm-project.org/) reservoir simulation deck files,
with syntax highlighting and development features backed by the full OPM Flow reference manual.

## Features

### Syntax Highlighting

Provides syntax highlighting for OPM Flow simulation deck files with support for:

- **Section headers**: `RUNSPEC`, `GRID`, `EDIT`, `PROPS`, `REGIONS`, `SOLUTION`, `SUMMARY`, `SCHEDULE`, `OPTIMIZE` — scoped so most themes render them in a distinct color (yellow in Dark+)
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
Each completion item shows the deck section (`RUNSPEC`, `GRID`, `SCHEDULE`, etc.) and
a one-line description in the documentation pane. Completions are triggered when typing
uppercase letters at the start of a line.

### Hover Tooltips

Hover over any keyword to see a quick tooltip with:

- A **description** from the reference manual
- A **parameter table** listing all record fields with units and defaults
- A usage **example**

Hovering over a **value in a data record** shows the description for that specific
parameter column. For example, hovering over the group name in a `WELSPECS` record
shows the `GRPNAME` parameter description, units, and default.

### Docs Panel (Sidebar)

Open the **Explorer** sidebar (`Ctrl+Shift+E`) and scroll down to the **OPM Keyword Reference** panel.
It updates automatically as you move the cursor — no keystrokes needed:

- **Cursor on a keyword** → full documentation: description, complete parameter table, example
- **Cursor on a value column** → same view with the matching parameter row highlighted
- **Cursor on whitespace or a comment** → panel retains the last shown keyword

The panel shows the keyword name, description, parameter table, and example.
This is the main view for reading long keyword documentation, since it scrolls freely
and stays visible while you edit.

### Align Record Columns

Tidy up record blocks so every column lines up. Invoke **OPM Flow: Align Record Columns**
from the Command Palette or the editor right-click menu. With a selection it aligns only
the selected lines; without one it aligns the whole document.

Groups of consecutive record lines (same token count) are reformatted in place:
strings left-aligned, numerics (including `N*` repeat markers) right-aligned. Keyword
headers, comment lines, the closing `/`, and trailing `-- comments` are left untouched.

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
 'PERMZ'   0.2 1 24 1 62  1  1 /
 'PERMZ'  0.04 1 24 1 62  2  2 /
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

### INCLUDE File Navigation

Quoted file paths on `INCLUDE` statements become clickable document links. Hold
`Ctrl` (or `Cmd` on macOS) and click the path — or right-click and choose
**Go to Definition** — to open the referenced file. Paths are resolved relative
to the including file's directory.

```
INCLUDE
  'grid/PERM.inc' /
```

### Generate Keyword Reference

**OPM Flow: Generate Keyword Reference** (Command Palette `Ctrl+Shift+P`) opens a
Markdown document listing all keywords grouped by section — useful for uploading
as context to an AI chat session.

## Supported File Extensions

The extension activates for the following extensions (case-sensitive on some platforms —
both common casings are registered where relevant):

Core deck files: `.data`, `.DATA`, `.inc`, `.INC`, `.include`, `.sch`, `.SCH`,
`.schedule`, `.summary`, `.grdecl`, `.GRDECL`, `.vfp`, `.VFP`, `.prop`, `.Ecl`, `.ecl`.

Section data files (Eclipse/OPM include conventions): `.aqucon`, `.aqunum`, `.dimens`,
`.eqlnum`, `.equil`, `.fault`, `.fipnum`, `.multnum`, `.multregp`, `.multregt`, `.nnc`,
`.ntg`, `.opernum`, `.perm`, `.poro`, `.pvt`, `.rocknum`, `.satnum`, `.sattab`,
`.tabdims`, `.thpres`.

## Installation in VS Code

### From the repository (development / local install)

1. **Install dependencies and compile:**
   ```bash
   cd vscode-extension
   npm install
   npm run compile
   ```

2. **Open the extension folder in VS Code**, then press **F5** to launch an Extension
   Development Host. All features will be active for any supported file you open.

3. **To install permanently** without publishing, package the extension and install it:
   ```bash
   npm install -g @vscode/vsce
   vsce package
   # produces opm-flow-0.6.0.vsix
   ```
   Then in VS Code: **Extensions → ⋯ → Install from VSIX…** and select the `.vsix` file.

## Updating the Keyword Index

The keyword documentation is extracted from the `.fodt` files in the reference manual
repository and stored in `data/keyword_index_compact.json`. When the manual is updated,
regenerate this file:

### Prerequisites

```bash
pip install lxml
```

### Run the extractor

From the **repository root** (one level above `vscode-extension/`):

```bash
python scripts/build_keyword_index.py \
    --manual-dir . \
    --output vscode-extension/data/keyword_index.json \
    --compact vscode-extension/data/keyword_index_compact.json
```

Or use the npm shortcut from inside `vscode-extension/`:

```bash
npm run build-index
```

This reads every `.fodt` file under `parts/chapters/subsections/` and produces:

| File | Size | Purpose |
|------|------|---------|
| `data/keyword_index.json` | ~22 MB | Full index with complete descriptions — not committed, not bundled |
| `data/keyword_index_compact.json` | ~1 MB | Compact index bundled in the extension |

After regenerating, recompile the extension (`npm run compile`) and commit
`data/keyword_index_compact.json`.

## Language ID

The language is registered as `opm-flow`.

## Requirements

- VS Code 1.74.0 or later
- Python 3.10+ with `lxml` (only required when regenerating the keyword index)

## Release Notes

### x.y.z

TODO