#!/usr/bin/env python3
"""
build_keyword_index.py

Parse OPM Flow reference manual (.fodt files) and build a JSON keyword index
suitable for use in AI-assisted editors (VS Code extension, ResInsight, etc.)

Usage:
    python build_keyword_index.py --manual-dir /path/to/opm-reference-manual \
                                  --output keyword_index.json

The manual is at: https://github.com/OPM/opm-reference-manual
Each keyword lives in: parts/chapters/subsections/X.3/KEYWORD.fodt
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Optional

from lxml import etree


# ---------------------------------------------------------------------------
# opm-common keyword JSON loader and merge
# ---------------------------------------------------------------------------
# opm-common is the OPM Flow parser's source-of-truth for which keywords are
# accepted, which sections they're valid in, and the type/dimension of each
# parameter. Each keyword lives in:
#     opm/input/eclipse/share/keywords/{dialect}/{LETTER}/{KEYWORD}
# where dialect is one of 000_Eclipse100, 001_Eclipse300, 002_Frontsim,
# 900_OPM. The file is JSON with shape:
#     { "name": ..., "sections": [...], "items": [{name, value_type,
#       dimension?, default?, comment?, item?}, ...] }

OPM_COMMON_DIALECTS = ("000_Eclipse100", "001_Eclipse300", "002_Frontsim", "900_OPM")


def _has_variable_arity_item(opm_items: list[dict]) -> bool:
    """
    True when any item declares ``size_type: "ALL"`` — those items consume
    every remaining value on the record, so the record's arity is unbounded.
    Keywords like RSVD, PVDO, PVTO use this for table data with variable row
    count per record. A fixed ``expected_columns`` would mis-classify legal
    records as over-arity, so callers should omit the field for these.
    """
    return any(it.get("size_type") == "ALL" for it in opm_items)


def _classify_size(opm_data: dict) -> tuple[str, Optional[int]]:
    """
    Classify an opm-common keyword's record arity into (kind, count).

    - "none":  flag/section-style keyword that takes no records and no '/'.
               Returned for explicit ``size: 0`` and for keywords with no
               ``size``, ``items``, ``records`` or ``data`` (e.g. WATER,
               METRIC, OIL).
    - "fixed": the keyword has a fixed number of records, each terminated
               by '/', with no trailing standalone '/' to close the block.
               ``count`` is the integer record count when known. ``size``
               given as a dict ``{keyword: X, item: Y}`` is also "fixed":
               the count comes from another keyword (e.g. RSVD takes
               ``EQLDIMS:NTEQUL`` records) but the deck still has no list
               terminator after the last record.
    - "list":  unbounded record list. Each record terminates with '/' and
               the block itself terminates with a standalone '/'. Used for
               ``size`` as a string sentinel (e.g. "UNKNOWN" on VFPPROD),
               for ``records`` shape (multi-record keywords like WELSEGS),
               and for keywords with ``items`` but no explicit ``size``.
    - "array": cell-property array (opm-common ``data`` shape). One stream
               of values across many lines, terminated by a single '/'.
               No per-record '/' and no separate list terminator — runtime
               terminator/arity checks must skip these. Returned for
               keywords with ``data`` and no ``items``/``size`` (PORO,
               PERMX, FIPNUM, ACTNUM, …).
    """
    size = opm_data.get("size")
    has_items   = bool(opm_data.get("items"))
    has_records = bool(opm_data.get("records"))
    has_data    = "data" in opm_data
    if size == 0:
        return "none", 0
    # Multi-record keywords (WELSEGS, VFPPROD, COMPSEGS, …) always end with
    # a standalone '/' line after the (variadic) trailing record, so they
    # are list-kind for terminator-diagnostic purposes.
    if has_records:
        return "list", None
    if isinstance(size, int) and size >= 1:
        return "fixed", size
    if isinstance(size, dict):
        return "fixed", None
    if isinstance(size, str):
        return "list", None
    if has_items:
        return "list", None
    if has_data:
        return "array", None
    return "none", 0


def load_opm_common_index(keywords_dir: Path) -> dict:
    """
    Walk the opm-common keywords tree and return a dict keyed by keyword name.

    Each value: ``{"sections": [...], "items": [...], "size_kind": str,
    "size_count": int|None}``. If a keyword appears in multiple dialect
    dirs (uncommon in practice), the first one wins.
    """
    if not keywords_dir.exists():
        sys.exit(f"ERROR: opm-common keywords dir not found: {keywords_dir}")

    out: dict[str, dict] = {}
    total = 0
    for dialect in OPM_COMMON_DIALECTS:
        dialect_dir = keywords_dir / dialect
        if not dialect_dir.exists():
            continue
        for letter_dir in sorted(p for p in dialect_dir.iterdir() if p.is_dir()):
            for kw_file in sorted(letter_dir.iterdir()):
                if not kw_file.is_file():
                    continue
                try:
                    with open(kw_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (OSError, json.JSONDecodeError) as e:
                    print(f"  WARNING: failed to read {kw_file}: {e}", file=sys.stderr)
                    continue
                name = data.get("name") or kw_file.name
                if name in out:
                    continue
                size_kind, size_count = _classify_size(data)
                out[name] = {
                    "sections":   data.get("sections", []),
                    "items":      data.get("items", []),
                    # Per-record item lists for multi-record keywords; None
                    # otherwise. Consumers that only know about flat ``items``
                    # ignore this field.
                    "records":    data.get("records"),
                    "size_kind":  size_kind,
                    "size_count": size_count,
                }
                total += 1
    print(f"Loaded {total} keywords from opm-common ({keywords_dir})")
    return out


def _opm_item_for_param(opm_items: list[dict], manual_index) -> Optional[dict]:
    """
    Return the opm-common item matching a manual parameter index.

    manual_index is a 1-based int or a string like "1-2" (grouped record).
    Match by explicit "item" field first, then by 1-based position.
    """
    if not opm_items:
        return None
    if isinstance(manual_index, int):
        pos = manual_index
    elif isinstance(manual_index, str):
        try:
            pos = int(manual_index.split("-")[0])
        except ValueError:
            return None
    else:
        return None

    for it in opm_items:
        if it.get("item") == pos:
            return it
    if 1 <= pos <= len(opm_items):
        return opm_items[pos - 1]
    return None


def _covered_indices(parameters: list[dict]) -> set[int]:
    """Return the set of 1-based record positions already covered by manual params.

    A grouped index like "1-2" covers both 1 and 2; bare ints cover themselves.
    """
    covered: set[int] = set()
    for p in parameters:
        idx = p.get("index")
        if isinstance(idx, int):
            covered.add(idx)
        elif isinstance(idx, str):
            try:
                lo, hi = (idx.split("-") + [None])[:2]
                lo_i = int(lo)
                hi_i = int(hi) if hi else lo_i
                covered.update(range(lo_i, hi_i + 1))
            except ValueError:
                pass
    return covered


def _synthesize_param_from_opm_item(item: dict, position: int) -> dict:
    """Build a manual-shape parameter dict from an opm-common item."""
    p = {
        "index":       item.get("item", position),
        "name":        item.get("name", f"item{position}"),
        "description": item.get("comment", ""),
        "units":       {},
        "default":     "" if "default" not in item else str(item["default"]),
    }
    if "value_type" in item:
        p["value_type"] = item["value_type"]
    if "dimension" in item:
        p["dimension"] = item["dimension"]
    return p


def _records_meta(records: list[list[dict]]) -> list[dict]:
    """
    Build per-record metadata for multi-record keywords. ``expected_columns``
    is omitted for records whose items use ``size_type: ALL`` because those
    consume all remaining values on the line.
    """
    meta: list[dict] = []
    for rec_items in records:
        m: dict = {}
        if rec_items and not _has_variable_arity_item(rec_items):
            m["expected_columns"] = len(rec_items)
        meta.append(m)
    return meta


def _merge_records_mode(
    entries: list[dict],
    records: list[list[dict]],
) -> tuple[int, int]:
    """
    Merge a multi-record opm-common entry into manual entries.

    Returns ``(merged_param_count, appended_param_count)``. The primary
    manual entry gets ``records_meta`` and a parameter list grouped by
    record (record 1 first, then record 2, …). Items missing from the
    manual are backfilled per record so the column-header generator and
    hovers always have a name.
    """
    merged = 0
    appended = 0
    primary = entries[0]
    manual_params = primary.get("parameters", [])

    # Group manual params by record. Manual params built in record-mode
    # carry ``record``; legacy entries lacking it are assumed record 1 so
    # we don't lose data.
    by_record: dict[int, list[dict]] = {}
    for p in manual_params:
        r = p.get("record", 1)
        by_record.setdefault(r, []).append(p)

    flat: list[dict] = []
    for ri, rec_items in enumerate(records, start=1):
        rec_params = by_record.get(ri, [])
        # Copy type/dimension into manual params from the matching item.
        for p in rec_params:
            it = _opm_item_for_param(rec_items, p.get("index"))
            if not it:
                continue
            if "value_type" in it:
                p["value_type"] = it["value_type"]
            if "dimension" in it:
                p["dimension"] = it["dimension"]
            merged += 1
        # Backfill items not represented in the manual.
        covered = _covered_indices(rec_params)
        for pos, it in enumerate(rec_items, start=1):
            item_pos = it.get("item", pos)
            if item_pos in covered:
                continue
            new_p = _synthesize_param_from_opm_item(it, item_pos)
            new_p["record"] = ri
            rec_params.append(new_p)
            covered.add(item_pos)
            appended += 1
        rec_params.sort(key=lambda p: (
            p["index"] if isinstance(p["index"], int)
            else int(str(p["index"]).split("-")[0])
        ))
        flat.extend(rec_params)

    primary["parameters"] = flat
    records_meta = _records_meta(records)
    for e in entries:
        e["records_meta"] = records_meta
    return merged, appended


def merge_opm_common(index: dict, opm_common_index: dict) -> None:
    """
    Mutate *index* in place, attaching opm-common authoritative data:

    - sections: replaced with opm-common's list when non-empty
    - expected_columns / records_meta: per-record column count(s) used by
      the extension to flag records with too many values. Single-record
      keywords get ``expected_columns``; multi-record keywords get
      ``records_meta`` (a list of ``{expected_columns?: int}`` per record).
    - parameters: each gets optional value_type and dimension copied from
      the matching opm-common item, and any opm-common items not represented
      in the manual are appended (so the per-record param list is complete
      even when the reference manual is missing entries).

    Manual entries that have no opm-common counterpart are left unchanged.
    """
    merged_sections = 0
    merged_params = 0
    appended_params = 0
    for name, entry in index.items():
        opm = opm_common_index.get(name)
        if not opm:
            continue
        entries = entry if isinstance(entry, list) else [entry]
        # Authoritative section list (skip when opm-common has none, e.g.
        # section-header keywords like RUNSPEC).
        if opm["sections"]:
            for e in entries:
                e["section"] = opm["sections"][0]
                e["sections_opm"] = list(opm["sections"])
            merged_sections += 1

        # Record arity / terminator classification (parser-truth) — needs
        # to be set regardless of whether the keyword is records- or
        # items-shaped, before the per-shape merge below.
        size_kind = opm.get("size_kind")
        if size_kind:
            for e in entries:
                e["size_kind"] = size_kind
        size_count = opm.get("size_count")
        if size_count is not None:
            for e in entries:
                e["size_count"] = size_count

        records = opm.get("records")
        if records:
            m, a = _merge_records_mode(entries, records)
            merged_params += m
            appended_params += a
            continue

        # Single-record (items-shaped) merge.
        if opm["items"] and not _has_variable_arity_item(opm["items"]):
            for e in entries:
                e["expected_columns"] = len(opm["items"])

        primary = entries[0]
        manual_params = primary.get("parameters", [])
        for p in manual_params:
            it = _opm_item_for_param(opm["items"], p.get("index"))
            if not it:
                continue
            if "value_type" in it:
                p["value_type"] = it["value_type"]
            if "dimension" in it:
                p["dimension"] = it["dimension"]
            merged_params += 1

        # Backfill items the manual is missing (e.g. COMPDAT item 14 / PR).
        # Without this, the column-header generator falls back to "COL14"
        # and hovers can't describe the position even though opm-common
        # knows its name and type.
        if opm["items"]:
            covered = _covered_indices(manual_params)
            for pos, it in enumerate(opm["items"], 1):
                item_pos = it.get("item", pos)
                if item_pos in covered:
                    continue
                manual_params.append(_synthesize_param_from_opm_item(it, item_pos))
                covered.add(item_pos)
                appended_params += 1
            manual_params.sort(key=lambda p: (
                p["index"] if isinstance(p["index"], int)
                else int(str(p["index"]).split("-")[0])
            ))
            primary["parameters"] = manual_params
    print(
        f"Merged opm-common: {merged_sections} keywords, "
        f"{merged_params} parameters, {appended_params} backfilled"
    )


# ---------------------------------------------------------------------------
# Enum-option extraction from manual descriptions
# ---------------------------------------------------------------------------
# Many STRING parameters list their valid values inside the description text
# in the form:  "FOO: explanation of FOO. BAR: explanation of BAR."
# We capture those tokens so the extension can offer them as completions.

_OPTION_RE = re.compile(r"\b([A-Z][A-Z0-9_]{1,9}):\s+(?=[a-z])")
_OPTION_BLOCKLIST = {"NOTE", "NB"}
_OPTION_MIN = 2  # only attach when at least this many distinct options found


def extract_string_options(description: str, param_name: str) -> list[str]:
    """
    Pull `WORD:` enum tokens out of a parameter description.
    Returns a deduplicated list in first-seen order, excluding the param's own
    name and a small blocklist of prose tokens like NOTE.
    """
    if not description:
        return []
    seen: list[str] = []
    for tok in _OPTION_RE.findall(description):
        if tok == param_name or tok in _OPTION_BLOCKLIST or tok in seen:
            continue
        seen.append(tok)
    return seen


def attach_string_options(index: dict) -> int:
    """
    Walk the index; for every STRING parameter where the description yields
    at least two enum-style options, attach them as `options`.
    Returns the number of parameters with options attached.
    """
    attached = 0
    for entry in index.values():
        primary = entry[0] if isinstance(entry, list) else entry
        for p in primary.get("parameters", []):
            if p.get("value_type") != "STRING":
                continue
            opts = extract_string_options(p.get("description", ""), p.get("name", ""))
            if len(opts) >= _OPTION_MIN:
                p["options"] = opts
                attached += 1
    print(f"Attached options to {attached} STRING parameters")
    return attached


def synthesize_opm_only_entries(index: dict, opm_common_index: dict) -> int:
    """
    Add manual-shape entries for keywords that exist in opm-common but not
    in the reference manual (e.g. OPM-specific keywords under 900_OPM/).
    Returns the number of entries added.
    """
    added = 0
    for name, opm in opm_common_index.items():
        if name in index:
            continue
        sections = list(opm["sections"])
        records = opm.get("records")
        items = opm["items"]

        if records:
            params: list[dict] = []
            for ri, rec_items in enumerate(records, start=1):
                for pos, it in enumerate(rec_items, start=1):
                    p = _synthesize_param_from_opm_item(it, it.get("item", pos))
                    p["record"] = ri
                    params.append(p)
        else:
            params = [
                _synthesize_param_from_opm_item(it, i + 1)
                for i, it in enumerate(items)
            ]

        entry = {
            "name":        name,
            # Empty list means "section unknown" — no validity check fires.
            "section":     sections[0] if sections else "",
            "sections_opm": sections,
            "supported":   True,
            "summary":     "(OPM Flow keyword — no reference-manual entry)",
            "description": "",
            "parameters":  params,
            "examples":    [],
            "full_text":   "",
            "source_file": "",
        }
        if records:
            entry["records_meta"] = _records_meta(records)
        elif items and not _has_variable_arity_item(items):
            entry["expected_columns"] = len(items)
        size_kind = opm.get("size_kind")
        if size_kind:
            entry["size_kind"] = size_kind
        size_count = opm.get("size_count")
        if size_count is not None:
            entry["size_count"] = size_count
        index[name] = entry
        added += 1
    print(f"Synthesized {added} OPM-only entries")
    return added


# ---------------------------------------------------------------------------
# ODF XML namespace map
# ---------------------------------------------------------------------------
NS = {
    "text":  "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "office":"urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
}

# Subsection number → OPM Flow deck section name
# Subsection 4.3 holds the "global" keywords (INCLUDE, ECHO, END, …) that are
# valid in every section. Those keyword files are also duplicated into each
# per-section subdirectory (5.3–12.3), so the multi-section merge picks up
# their full section set from there and 4.3 is skipped.
SECTION_MAP = {
    "5.3":  "RUNSPEC",
    "6.3":  "GRID",
    "7.3":  "EDIT",
    "8.3":  "PROPS",
    "9.3":  "REGIONS",
    "10.3": "SOLUTION",
    "11.3": "SUMMARY",
    "12.3": "SCHEDULE",
}

# Paragraph style names that indicate a heading in the OPM manual
# (inspect a .fodt file to confirm; these are common LibreOffice defaults)
HEADING_STYLES = {
    "Heading_20_1", "Heading_20_2", "Heading_20_3",
    "Heading 1", "Heading 2", "Heading 3",
}

EXAMPLE_HEADING_RE = re.compile(r"example", re.IGNORECASE)
SUPPORTED_RE       = re.compile(r"(supported|not\s+supported)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Low-level XML helpers
# ---------------------------------------------------------------------------

NS_DRAW = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
NS_MATH = "http://www.w3.org/1998/Math/MathML"
_FRAME_TAG  = f"{{{NS_DRAW}}}frame"
_ANNOT_TAG  = f"{{{NS_MATH}}}annotation"


def _formula_text(frame_elem) -> str:
    """Extract a readable formula string from a draw:frame containing MathML."""
    annot = frame_elem.find(f".//{_ANNOT_TAG}")
    if annot is not None and annot.text and annot.text.strip():
        return f"[{annot.text.strip()}]"
    return "[formula]"


def all_text(element) -> str:
    """Recursively collect all text content, replacing math frames with annotations."""
    if element.tag == _FRAME_TAG:
        tail = element.tail or ""
        return _formula_text(element) + tail
    parts = []
    if element.text:
        parts.append(element.text)
    for child in element:
        parts.append(all_text(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def style_name(element) -> str:
    return element.get(f"{{{NS['text']}}}style-name", "")


_P_TAG = f"{{{NS['text']}}}p"
_H_TAG = f"{{{NS['text']}}}h"


def iter_paragraphs(body):
    """Yield (is_heading, style, text) for every text:p and text:h in document order.

    text:h elements are headings regardless of their style-name (the OPM manual
    uses auto-generated style names like "P97" for headings, so the tag itself
    is the reliable signal).
    """
    for elem in body.iter(_P_TAG, _H_TAG):
        text = all_text(elem).strip()
        if not text:
            continue
        yield elem.tag == _H_TAG, style_name(elem), text


def cell_span(cell_elem) -> int:
    return int(cell_elem.get(f"{{{NS['table']}}}number-columns-spanned", "1"))


def cell_text(cell_elem) -> str:
    return " ".join(
        all_text(p).strip()
        for p in cell_elem.iter(f"{{{NS['text']}}}p")
    ).strip()


def extract_raw_rows(table_elem) -> list[list[tuple[str, int]]]:
    """
    Return rows as lists of (text, span) tuples, skipping fully-empty rows.
    Uses iter() so rows inside table:header-rows are also included.
    """
    rows = []
    for row in table_elem.iter(f"{{{NS['table']}}}table-row"):
        cells = [
            (cell_text(c), cell_span(c))
            for c in row.findall(f"{{{NS['table']}}}table-cell")
        ]
        if any(txt for txt, _ in cells):
            rows.append(cells)
    return rows


_PARAM_INDEX_RE = re.compile(r"^\d+(?:-\d+)?$")


def _is_param_index(text: str) -> bool:
    """Accept a bare integer ("1") or a grouped record index ("1-2", used by
    multi-record keywords like VFPPROD/VFPINJ)."""
    return bool(_PARAM_INDEX_RE.match(text.strip()))


def is_param_row(cells: list[tuple[str, int]]) -> bool:
    """True when the first cell is a parameter index."""
    return bool(cells) and _is_param_index(cells[0][0])


def is_unit_row(cells: list[tuple[str, int]]) -> bool:
    """
    True for the optional row that carries Field/Metric/Laboratory units.
    These rows have exactly 3 single-span cells and no leading parameter index.
    """
    return (
        len(cells) == 3
        and all(span == 1 for _, span in cells)
        and not _is_param_index(cells[0][0])
        and not cells[0][0].strip().lower().startswith("note")
    )


def _detect_name_span(raw_rows: list[list[tuple[str, int]]]) -> int:
    """
    Return how many logical columns the "Name" header occupies.

    PVTO/PVTG/PVTGW/PVTGWO/PVTSOL use ``span=2`` because each parameter row
    can hold a saturated/under-saturated name pair (e.g. PRSS / PRSU). All
    other manual tables use ``span=1``.
    """
    for cells in raw_rows:
        if cells and cells[0][0] == "No.":
            for txt, span in cells[1:]:
                if txt == "Name":
                    return span
            return 1
    return 1


_RECORD_INDEX_RE = re.compile(r"^(\d+)-(\d+)$")


def _detect_record_mode(raw_rows: list[list[tuple[str, int]]]) -> bool:
    """
    True when the index column carries record-major coordinates spanning
    multiple records — e.g. WELSEGS rows ``1-1..1-13`` plus ``2-1..2-16``.

    Single-record grouped indices like WLIST's ``3-52`` (one cell, one
    distinct record number) do not qualify; only the second pattern, where
    at least two distinct record numbers appear, switches us into the
    multi-record interpretation of "X-Y".
    """
    record_numbers: set[int] = set()
    for cells in raw_rows:
        if not cells:
            continue
        m = _RECORD_INDEX_RE.match(cells[0][0].strip())
        if m:
            record_numbers.add(int(m.group(1)))
            if len(record_numbers) >= 2:
                return True
    return False


def parse_param_table(table_elem) -> list[dict]:
    """
    Parse a keyword parameter table into a list of parameter dicts.

    Each dict has:
        index       – 1-based integer (or grouped string like "3-52" for
                      single-record variadic ranges)
        record      – 1-based record number, present only for multi-record
                      keywords (WELSEGS, VFPPROD, COMPSEGS, …) where the
                      index column reads "R-P". Absent for single-record
                      keywords so existing consumers keep working.
        name        – parameter name string (joined with " / " when the row
                      defines two related columns, e.g. "PRSS / PRSU")
        description – full description text
        units       – {"field": ..., "metric": ..., "laboratory": ...} or {}
        default     – default value string (may be empty)

    Synthetic rows whose Name is just "/" document the per-record terminator
    in the manual; they are not real parameters and are dropped.
    """
    raw = extract_raw_rows(table_elem)
    name_span    = _detect_name_span(raw)
    record_mode  = _detect_record_mode(raw)
    # Normalise record numbering to 1-based so it lines up with opm-common's
    # ``records`` list. TUNINGS uses 0-1/0-2 for what opm-common calls record
    # 1; without this shift those manual params would be orphaned during the
    # merge.
    record_offset = 0
    if record_mode:
        min_record = min(
            int(_RECORD_INDEX_RE.match(c[0][0].strip()).group(1))
            for cells in raw if cells
            for c in [cells]
            if _RECORD_INDEX_RE.match(c[0][0].strip())
        )
        if min_record == 0:
            record_offset = 1
    params = []
    pending_param = None

    for cells in raw:
        texts = [t for t, _ in cells]

        # Skip header rows (contain "No.", "Name", "Description", "Field" …)
        if texts and texts[0] in ("No.", "Field", ""):
            continue

        if is_param_row(cells):
            # Flush previous pending param (it had no unit row)
            if pending_param is not None:
                params.append(pending_param)
                pending_param = None

            raw_idx = cells[0][0].strip()
            record: Optional[int] = None
            idx: int | str
            if record_mode:
                m = _RECORD_INDEX_RE.match(raw_idx)
                if m:
                    record = int(m.group(1)) + record_offset
                    idx    = int(m.group(2))
                else:
                    # bare integer in a record-mode table — treat as record 1
                    record = 1
                    idx    = int(raw_idx) if raw_idx.isdigit() else raw_idx
            else:
                idx = int(raw_idx) if raw_idx.isdigit() else raw_idx

            # Walk Name cells until we've covered name_span logical columns.
            # Single-name rows use one cell with span=name_span; dual-name
            # rows use one cell per name (each span=1).
            cell_idx = 1
            consumed = 0
            name_parts: list[str] = []
            while cell_idx < len(cells) and consumed < name_span:
                txt, span = cells[cell_idx]
                if txt:
                    name_parts.append(txt)
                consumed += span
                cell_idx += 1
            name = " / ".join(name_parts)

            # Drop synthetic '/' terminator rows — these document the record
            # terminator and are not real parameters.
            if name == "/":
                continue

            desc    = cells[cell_idx][0] if cell_idx < len(cells) else ""
            default = cells[cell_idx + 1][0] if cell_idx + 1 < len(cells) else ""

            pending_param = {
                "index":       idx,
                "name":        name,
                "description": desc,
                "units":       {},
                "default":     default,
            }
            if record is not None:
                pending_param["record"] = record

        elif is_unit_row(cells) and pending_param is not None:
            pending_param["units"] = {
                "field":       texts[0],
                "metric":      texts[1],
                "laboratory":  texts[2],
            }
            params.append(pending_param)
            pending_param = None

        # Notes rows and other non-param rows are ignored

    if pending_param is not None:
        params.append(pending_param)

    return params


def params_to_markdown(params: list[dict]) -> str:
    """Render structured parameters as a markdown table."""
    if not params:
        return ""

    has_units = any(p["units"] for p in params)

    if has_units:
        header = "| No. | Name | Description | Field | Metric | Laboratory | Default |"
        sep    = "|-----|------|-------------|-------|--------|------------|---------|"
        lines  = [header, sep]
        for p in params:
            u = p["units"]
            lines.append(
                f"| {p['index']} | `{p['name']}` | {p['description']} "
                f"| {u.get('field','')} | {u.get('metric','')} | {u.get('laboratory','')} "
                f"| {p['default']} |"
            )
    else:
        header = "| No. | Name | Description | Default |"
        sep    = "|-----|------|-------------|---------|"
        lines  = [header, sep]
        for p in params:
            lines.append(
                f"| {p['index']} | `{p['name']}` | {p['description']} | {p['default']} |"
            )

    return "\n".join(lines)


def extract_example_tables(tables) -> list[str]:
    """Convert non-parameter tables (examples, etc.) to simple markdown."""
    results = []
    for tbl in tables:
        raw = extract_raw_rows(tbl)
        if not raw:
            continue
        # Simple flat rendering for example tables
        col_count = max(sum(span for _, span in row) for row in raw)
        flat_rows = []
        for cells in raw:
            flat = [txt for txt, _ in cells]
            flat_rows.append(flat)
        if flat_rows:
            results.append(_simple_markdown(flat_rows))
    return results


def _simple_markdown(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    col_count = max(len(r) for r in rows)
    col_widths = [
        max((len(row[i]) if i < len(row) else 0) for row in rows)
        for i in range(col_count)
    ]
    lines = []
    for idx, row in enumerate(rows):
        padded = [
            (row[i] if i < len(row) else "").ljust(col_widths[i])
            for i in range(col_count)
        ]
        lines.append("| " + " | ".join(padded) + " |")
        if idx == 0:
            lines.append("|" + "|".join("-" * (w + 2) for w in col_widths) + "|")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Per-keyword .fodt parser
# ---------------------------------------------------------------------------

def parse_keyword_file(fodt_path: Path, section: str) -> dict:
    """
    Parse a single keyword .fodt file and return a structured dict.

    Output schema:
    {
        "name":        "WELSPECS",
        "section":     "SCHEDULE",
        "supported":   true,
        "summary":     "First paragraph of description",
        "description": "Full description text",
        "parameters":  [
            {
                "index": 1, "name": "WELNAME",
                "description": "...",
                "units": {"field": "feet", "metric": "m", "laboratory": "cm"},
                "default": "None"
            }, ...
        ],
        "examples":    ["example text 1", ...],
        "full_text":   "All plain text in the document",
        "source_file": "parts/.../WELSPECS.fodt"
    }
    """
    keyword_name = fodt_path.stem

    # Several manual files (WELSEGS, ACTIONX, EHYSTR, RPTRST, UDQ) reuse the
    # same xml:id on multiple <text:list> elements, which the strict parser
    # rejects. Use the recovering parser so these keywords still produce a
    # usable tree — content is unaffected, only the duplicate-id constraint
    # is relaxed.
    parser = etree.XMLParser(recover=True, huge_tree=True)
    try:
        with open(fodt_path, "rb") as f:
            data = f.read()
        root = etree.fromstring(data, parser=parser)
    except etree.XMLSyntaxError as e:
        print(f"  WARNING: XML parse error in {fodt_path.name}: {e}", file=sys.stderr)
        return None
    if root is None:
        print(f"  WARNING: empty tree after recovery in {fodt_path.name}", file=sys.stderr)
        return None

    body = root.find(f".//{{{NS['office']}}}text")
    if body is None:
        print(f"  WARNING: No office:text in {fodt_path.name}", file=sys.stderr)
        return None

    # --- collect paragraphs in document order ---------------------------
    description_parts = []
    example_parts     = []
    all_text_parts    = []
    in_example        = False
    supported         = None

    for is_heading, style, text in iter_paragraphs(body):
        all_text_parts.append(text)

        if supported is None:
            m = SUPPORTED_RE.search(text)
            if m:
                supported = "not" not in m.group(0).lower()

        if is_heading or style in HEADING_STYLES:
            in_example = bool(EXAMPLE_HEADING_RE.search(text))
            continue

        if in_example:
            example_parts.append(text)
        else:
            description_parts.append(text)

    # --- parse tables ---------------------------------------------------
    # Table 0: section-applicability (single row of section names) — skip
    # Table 1: parameter definition table
    # Tables 2+: example/other tables
    tables = body.findall(f".//{{{NS['table']}}}table")

    params: list[dict] = []
    example_table_md_parts: list[str] = []

    for i, tbl in enumerate(tables):
        raw = extract_raw_rows(tbl)
        if not raw:
            continue

        first_row_texts = [t for t, _ in raw[0]]

        # The parameter table starts with "No." in the first cell
        if "No." in first_row_texts:
            params = parse_param_table(tbl)
        elif i > 0:
            example_table_md_parts.extend(extract_example_tables([tbl]))

    # --- assemble summary ----------------------------------------------
    summary = next(
        (p for p in description_parts if len(p) > 30 and p != keyword_name),
        ""
    )

    return {
        "name":        keyword_name,
        "section":     section,
        "supported":   supported,
        "summary":     summary,
        "description": "\n\n".join(description_parts),
        "parameters":  params,
        "examples":    example_parts + example_table_md_parts,
        "full_text":   "\n".join(all_text_parts),
        "source_file": str(fodt_path),
    }


# ---------------------------------------------------------------------------
# Directory walker
# ---------------------------------------------------------------------------

def build_index(manual_dir: Path) -> dict:
    """
    Walk all subsection dirs and parse every keyword .fodt file.
    Returns { "KEYWORD_NAME": {...}, ... }
    """
    subsections_root = manual_dir / "parts" / "chapters" / "subsections"

    if not subsections_root.exists():
        sys.exit(f"ERROR: subsections directory not found: {subsections_root}")

    index = {}
    total = 0
    skipped = 0

    for section_num, section_name in SECTION_MAP.items():
        section_dir = subsections_root / section_num
        if not section_dir.exists():
            print(f"  INFO: directory not found, skipping: {section_dir}")
            continue

        fodt_files = sorted(section_dir.glob("*.fodt"))
        print(f"  {section_name:10s} ({section_num}): {len(fodt_files)} files")

        for fodt_path in fodt_files:
            result = parse_keyword_file(fodt_path, section_name)
            if result is None:
                skipped += 1
                continue
            name = result["name"]
            if name in index:
                # Some keywords appear in multiple sections (e.g. INCLUDE)
                # Keep both; append section to disambiguate
                print(f"    NOTE: duplicate keyword {name} in {section_name}, merging")
                existing = index[name]
                if isinstance(existing, list):
                    existing.append(result)
                else:
                    index[name] = [existing, result]
            else:
                index[name] = result
            total += 1

    print(f"\nIndexed {total} keywords ({skipped} skipped)")
    return index


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def write_json(index: dict, output_path: Path):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
    size_kb = output_path.stat().st_size // 1024
    print(f"Wrote {output_path}  ({size_kb} KB, {len(index)} keywords)")


def write_compact_json(index: dict, output_path: Path):
    """
    Write a compact JSON suitable for bundling in the VS Code extension.
    Parameters are stored as structured dicts (not pre-rendered markdown)
    so the extension can render them however it likes.
    """
    compact = {}
    for name, entry in index.items():
        if isinstance(entry, list):
            primary = entry[0]
            # When opm-common merge ran, sections_opm is the authoritative list
            # (and may legitimately be empty for synthesized OPM-only keywords
            # whose section is unknown). Otherwise fall back to per-entry
            # manual sections.
            if "sections_opm" in primary:
                sections = list(primary["sections_opm"])
            else:
                sections = [e["section"] for e in entry if e.get("section")]
        else:
            primary = entry
            if "sections_opm" in primary:
                sections = list(primary["sections_opm"])
            else:
                sec = primary.get("section", "")
                sections = [sec] if sec else []
        examples = primary.get("examples", [])
        example_text = "\n".join(e for e in examples if isinstance(e, str))[:4000]
        summary = primary.get("summary", "")
        SUMMARY_LIMIT = 1000
        if len(summary) > SUMMARY_LIMIT:
            summary = summary[:SUMMARY_LIMIT].rstrip() + "..."
        out_entry = {
            "name":        primary["name"],
            "sections":    sections,
            "supported":   primary["supported"],
            "summary":     summary,
            "parameters":  primary.get("parameters", []),
            "example":     example_text,
        }
        expected = primary.get("expected_columns")
        if expected:
            out_entry["expected_columns"] = expected
        records_meta = primary.get("records_meta")
        if records_meta:
            out_entry["records_meta"] = records_meta
        size_kind = primary.get("size_kind")
        if size_kind:
            out_entry["size_kind"] = size_kind
        size_count = primary.get("size_count")
        if size_count is not None:
            out_entry["size_count"] = size_count
        compact[name] = out_entry
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(compact, f, separators=(",", ":"), ensure_ascii=False)
    size_kb = output_path.stat().st_size // 1024
    print(f"Wrote compact JSON: {output_path}  ({size_kb} KB, {len(compact)} keywords)")


def write_summary_tsv(index: dict, output_path: Path):
    """
    Lightweight companion file: keyword TAB section TAB supported TAB summary
    Useful for quick loading in the LSP server without parsing full JSON.
    """
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("keyword\tsections\tsupported\tparam_count\tsummary\n")
        for name, entry in sorted(index.items()):
            if isinstance(entry, list):
                sections = ",".join(e["section"] for e in entry)
                primary = entry[0]
            else:
                sections = entry["section"]
                primary = entry
            supported  = {True: "yes", False: "no", None: "unknown"}[primary["supported"]]
            summary    = primary["summary"].replace("\t", " ").replace("\n", " ")[:120]
            param_count = len(primary["parameters"]) if isinstance(primary["parameters"], list) else 0
            f.write(f"{name}\t{sections}\t{supported}\t{param_count}\t{summary}\n")
    print(f"Wrote summary TSV: {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Build a keyword index from the OPM Flow reference manual (.fodt files)"
    )
    parser.add_argument(
        "--manual-dir", required=True,
        help="Path to cloned opm-reference-manual repository"
    )
    parser.add_argument(
        "--output", default="keyword_index.json",
        help="Output JSON file (default: keyword_index.json)"
    )
    parser.add_argument(
        "--tsv", default="keyword_summary.tsv",
        help="Output TSV summary file (default: keyword_summary.tsv)"
    )
    parser.add_argument(
        "--compact", default=None,
        help="Output compact JSON for VS Code extension bundling (e.g. --compact keyword_index_compact.json)"
    )
    parser.add_argument(
        "--opm-common-dir", default=None,
        help="Path to opm-common keywords dir "
             "(opm/input/eclipse/share/keywords). When given, sections and "
             "per-parameter type/dimension are merged from opm-common."
    )
    parser.add_argument(
        "--keyword", default=None,
        help="Parse and print a single keyword for debugging (e.g. --keyword WELSPECS)"
    )
    args = parser.parse_args()

    manual_dir = Path(args.manual_dir).expanduser().resolve()

    if args.keyword:
        # Debug mode: find and dump one keyword
        for section_num, section_name in SECTION_MAP.items():
            p = manual_dir / "parts" / "chapters" / "subsections" / section_num / f"{args.keyword}.fodt"
            if p.exists():
                result = parse_keyword_file(p, section_name)
                print(json.dumps(result, indent=2, ensure_ascii=False))
                return
        print(f"Keyword file not found: {args.keyword}")
        return

    print(f"Building index from: {manual_dir}")
    index = build_index(manual_dir)

    if args.opm_common_dir:
        opm_common_index = load_opm_common_index(
            Path(args.opm_common_dir).expanduser().resolve()
        )
        merge_opm_common(index, opm_common_index)
        synthesize_opm_only_entries(index, opm_common_index)
        attach_string_options(index)

    write_json(index, Path(args.output))
    if args.tsv:
        write_summary_tsv(index, Path(args.tsv))
    if args.compact:
        write_compact_json(index, Path(args.compact))


if __name__ == "__main__":
    main()
