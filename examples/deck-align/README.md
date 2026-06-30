# Deck column-alignment example

A tiny, self-contained deck for exercising **OPM Flow: Align Record Columns in Deck**.

```
DECK_ALIGN.DATA              root deck (WELSPECS table)
└─ include/schedule.inc      WCONPROD / GCONPROD tables   (INCLUDE via $INC alias)
   └─ include/wells.inc      COMPDAT table                (nested INCLUDE)
```

## How to test

1. Open `DECK_ALIGN.DATA`.
2. Run **OPM Flow: Align Record Columns in Deck** (Command Palette or editor
   right-click menu).
3. The command follows the `INCLUDE` chain — resolving the `$INC` `PATHS` alias
   and the nested include — and aligns the record tables in all three files in a
   single edit.

Every record table ships deliberately mis-aligned, so the effect is obvious. To
test the exclusion setting, add e.g. `"COMPDAT"` to
`opm-flow.formatting.alignColumnsExcludedKeywords` and confirm `wells.inc` is
left untouched.
