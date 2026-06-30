-- Schedule include reached via the $INC PATHS alias from DECK_ALIGN.DATA.
-- Misaligned record tables below should be aligned by
-- "OPM Flow: Align Record Columns in Deck".

WCONPROD
 'PROD1' 'OPEN' 'ORAT' 1000 4* 50 /
 'PROD2' 'OPEN' 'ORAT' 800 4* 45 /
/

GCONPROD
 'G1' 'ORAT' 5000 3* 'RATE' /
 'G2' 'ORAT' 2500 3* 'RATE' /
/

-- Nested INCLUDE (relative to this file) - the collector recurses into it.
INCLUDE
 'wells.inc' /
