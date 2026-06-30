# Demo decks

A small, self-contained set of OPM Flow simulation decks used to demonstrate the
**OPM Flow editor support** VS Code extension in short feature videos.

The decks are trimmed copies of cases from
[`opm-tests`](https://github.com/OPM/opm-tests); every `INCLUDE` and `PATHS`
reference resolves inside its own folder, so each deck opens and navigates
without any external files.

| Folder | Deck | Feature focus |
|--------|------|---------------|
| `01-spe1-basics/`        | `SPE1CASE1.DATA`   | Highlighting, section/keyword folding, hover, diagnostics + quick fixes, completion (boilerplate snippets), **Align Record Columns**, **Add Column Headers**, docs sidebar, Generate Keyword Reference, **Verify Deck** / **Run Simulation** + **Open PRT File** |
| `02-udq-actionx/`        | `UDQ_WCONPROD.DATA`, `ACTIONX_M1.DATA` | UDQ three-column alignment, UDQ/ACTIONX recognition + hover, value completion |
| `03-includes-and-names/` | `TEST1_WS.DATA`    | `Ctrl+click` `INCLUDE` navigation, well/group-name completion from `WELSPECS`/`GRUPTREE` |
| `04-msw-multirecord/`    | `MSW-SIMPLE.DATA`  | Multi-record keyword hover (`WELSEGS`/`COMPSEGS`), per-record **Add Column Headers**, `PATHS` alias navigation |

See [`VIDEO-SCRIPT.md`](VIDEO-SCRIPT.md) for the shot-by-shot capture script.

> Source attribution and licensing follow the original `opm-tests` repository
> (Open Database License). These files are for demonstration only and are not
> tuned to run as production cases.
