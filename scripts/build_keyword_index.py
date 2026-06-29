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
import copy
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

# Keywords whose "record" is just free-form text on the line after the
# keyword name, with no '/' terminator. opm-common shapes these as
# ``size: 1, items: [{ size_type: "ALL", value_type: "STRING" }]``, which
# the generic classifier reasonably calls "fixed/1" — but that prompts
# the diagnostics engine to demand a trailing '/' that real decks never
# write. Override them to ``size_kind: "none"`` so the next-line text
# is accepted as the title without complaint.
RAW_TEXT_KEYWORDS = frozenset({"TITLE"})

# Keywords that exist in the manual under a base name but are *templates* —
# the deck appends a tracer/phase suffix to form the actual keyword name.
# TVDP is documented as such: real decks write e.g. TVDPFSEA (free tracer
# SEA), TVDPSIGS (solution tracer IGS), TVDPFWT1 (free tracer WT1).
# FIP is similar: the manual states "FIP as the first three characters
# followed by up to a five letter character string", producing deck tokens
# like FIPZON, FIPGL, FIPNL, FIPUNIT, FIPHC, ….
TEMPLATE_KEYWORD_NAMES = frozenset({"TVDP", "FIP"})

# Region-number keywords that have per-direction Cartesian variants formed by
# appending X / Y / Z to the base name (KRNUM -> KRNUMX/KRNUMY/KRNUMZ, IMBNUM
# -> IMBNUMX/...). opm-common defines only the base name, so real decks using
# the directional forms would otherwise be flagged as unknown keywords. Each
# variant copies the base entry (same sections / shape / docs).
DIRECTIONAL_VARIANT_BASES = frozenset({"KRNUM", "IMBNUM"})
DIRECTIONAL_SUFFIXES = ("X", "Y", "Z")

# Keywords whose record body is conventionally spread across multiple
# lines, with only the line carrying '/' completing the record. opm-common's
# size_type rarely flags these (the items aren't ``size_type: "ALL"``), but
# real decks routinely split them — MESSAGES is the canonical fixed-record
# case (12-13 INT values across two lines), and VFPPROD/VFPINJ's axis and
# BHP-table records each span many lines:
#
#     VFPPROD
#       1 1535 LIQ WCT GOR THP PUMP METRIC BHP /
#       100.0 123.0 ... 228.0
#       280.0 ... 5000.0 /
#       ...
#
# Tag these explicitly so per-line missing-'/' diagnostics are suppressed.
VARIADIC_RECORD_KEYWORDS = frozenset({"MESSAGES", "VFPPROD", "VFPINJ"})

# Multi-record keywords whose block ends with the trailing record's '/'
# rather than a separate standalone '/'. opm-common classifies them as
# 'list' (size = None/string sentinel) but real decks never close them
# with a standalone '/' — the next keyword is what ends the block.
# Reclassified to 'fixed' (size_count = records_meta.length) so the
# diagnostics engine doesn't demand a closing terminator.
NO_LIST_TERMINATOR_KEYWORDS = frozenset({"VFPPROD", "VFPINJ"})


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
    # Multi-record keywords with an *integer* size (TUNING/TUNINGL/TUNINGS,
    # PLYSHLOG, PRORDER, PYACTION) have a fixed record count and no
    # standalone '/' terminator after the last record — classify them as
    # "fixed" so the diagnostics engine doesn't demand a closing '/'.
    if has_records and isinstance(size, int) and size >= 1:
        return "fixed", size
    # Variadic multi-record keywords (WELSEGS, VFPPROD, COMPSEGS, …) have
    # size=None or a string sentinel ("UNKNOWN") and DO end with a
    # standalone '/' after the trailing record — those stay list-kind.
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
                if name in RAW_TEXT_KEYWORDS:
                    size_kind, size_count = "none", None
                out[name] = {
                    "sections":   data.get("sections", []),
                    "items":      data.get("items", []),
                    # Per-record item lists for multi-record keywords; None
                    # otherwise. Consumers that only know about flat ``items``
                    # ignore this field.
                    "records":    data.get("records"),
                    "size_kind":  size_kind,
                    "size_count": size_count,
                    # Summary-vector "PROBE" families (WELL_PROBE, FIELD_PROBE,
                    # …) enumerate their concrete deck mnemonics here, plus a
                    # regex for the open-ended families (UDQ, tracers). Retained
                    # so the build can expand them into recognised entries.
                    "deck_names":       data.get("deck_names"),
                    "deck_name_regex":  data.get("deck_name_regex"),
                    # Cross-keyword constraints (parser-truth). ``requires`` lists
                    # keywords that must also appear in the deck; ``prohibits``
                    # lists keywords that may not co-exist with this one. Both are
                    # flat lists of canonical keyword names. Surfaced so the
                    # diagnostics engine can emit "X requires Y" / "X conflicts
                    # with Y" warnings.
                    "requires":         data.get("requires"),
                    "prohibits":        data.get("prohibits"),
                    "comment":          data.get("comment", ""),
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


def _attach_cross_keyword(entry: dict, opm: dict) -> None:
    """Copy the ``requires`` / ``prohibits`` lists from an opm-common entry onto
    *entry* (a manual-shape dict), skipping empty/absent values so keywords
    without constraints stay free of the fields."""
    requires = opm.get("requires")
    if requires:
        entry["requires"] = list(requires)
    prohibits = opm.get("prohibits")
    if prohibits:
        entry["prohibits"] = list(prohibits)


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

        # Cross-keyword constraints — independent of record shape.
        for e in entries:
            _attach_cross_keyword(e, opm)

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
        elif opm["items"] and _has_variable_arity_item(opm["items"]):
            # Items with size_type="ALL" consume all remaining values on the
            # record. Real decks split such records across many lines (RSVD,
            # RVVD, PVDO, PVTO, …) and only the line containing '/' closes
            # the record. Flag this so the diagnostics engine doesn't
            # complain about every intermediate line missing a terminator.
            for e in entries:
                e["variadic_record"] = True

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


def add_directional_variants(index: dict) -> int:
    """
    Emit per-direction Cartesian variants (X/Y/Z) for the region-number
    keywords in DIRECTIONAL_VARIANT_BASES. Each variant is a copy of the base
    entry with its name updated. Returns the number of variants added.
    """
    added = 0
    for base in DIRECTIONAL_VARIANT_BASES:
        base_entry = index.get(base)
        if not base_entry:
            continue
        for suffix in DIRECTIONAL_SUFFIXES:
            name = f"{base}{suffix}"
            if name in index:
                continue
            entry = copy.deepcopy(base_entry)
            entry["name"] = name
            index[name] = entry
            added += 1
    print(f"Added {added} directional region-keyword variants")
    return added


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
        _attach_cross_keyword(entry, opm)
        index[name] = entry
        added += 1
    print(f"Synthesized {added} OPM-only entries")
    return added


def _probe_summary(comment: str, probe_name: str) -> str:
    """One-line summary for an expanded summary-vector entry, derived from the
    PROBE family comment (first non-empty line, trimmed)."""
    for line in (comment or "").splitlines():
        line = line.strip()
        if line:
            return (line[:117] + "...") if len(line) > 120 else line
    return f"OPM Flow summary vector ({probe_name})"


def expand_probe_deck_names(index: dict, opm_common_index: dict) -> int:
    """
    Expand the ``deck_names`` of opm-common summary-vector PROBE families
    (WELL_PROBE, FIELD_PROBE, BLOCK_PROBE, …) into individual recognised
    entries. Each is a minimal entry (name, sections, one-line summary) with no
    size shape, so it is recognised by the diagnostics engine without triggering
    arity or terminator checks. Existing entries (e.g. WOPR from the manual) are
    left untouched. Returns the number of entries added.
    """
    added = 0
    for probe_name, opm in opm_common_index.items():
        deck_names = opm.get("deck_names")
        if not deck_names:
            continue
        sections = list(opm.get("sections", []))
        summary = _probe_summary(opm.get("comment", ""), probe_name)
        for dn in deck_names:
            if not dn or dn in index:
                continue
            index[dn] = {
                "name":         dn,
                "section":      sections[0] if sections else "",
                "sections_opm": sections,
                "supported":    True,
                "summary":      summary,
                "description":  "",
                "parameters":   [],
                "examples":     [],
                "full_text":    "",
                "source_file":  "",
            }
            added += 1
    print(f"Expanded {added} summary-vector deck names")
    return added


def collect_deck_name_regexes(opm_common_index: dict) -> list[str]:
    """Unique ``deck_name_regex`` patterns across all PROBE families, used by
    the diagnostics engine to recognise open-ended summary-vector families
    (UDQ, tracer, water-cut-bucket mnemonics)."""
    seen: dict[str, None] = {}
    for opm in opm_common_index.values():
        rx = opm.get("deck_name_regex")
        if rx:
            seen.setdefault(rx, None)
    return list(seen)


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
# SUMMARY mnemonics (FOPR, WOPR, GGOR, …)
# ---------------------------------------------------------------------------
# These aren't shipped as per-keyword .fodt files. They live as rows in the
# tables under chapter 11 section 2 ("Data Requirements") — one row per
# physical quantity, with the actual deck keywords listed in scope-named
# columns (Field, Group, Well, Region, Block, …). The cell content is the
# mnemonic; an empty cell means that scope isn't defined for that quantity.

# Mnemonic tables in section 11.2 all carry "Summary Variables" or
# "Summary Recovery Variables" in their title (Aquifer, Field/Group/Well,
# Block/Field/Region, Recovery, plus the option-specific ones: Polymer,
# Network Model, CO2STORE, Foam, etc.). The performance-counter table
# ("OPM Flow Simulation Performance") has a different shape and is
# handled separately via a header check.
SUMMARY_TABLE_TITLE_RE = re.compile(r"Summary (Variables|Recovery Variables)$")

# Column headers within those tables whose cells hold actual SUMMARY mnemonics.
# Anything else (Type, Variable, Root, Comment) is metadata about the row.
# WellSegment covers the Multi-Segment Wells table's S-prefix mnemonics;
# WellLateral covers the L-prefix completion-lateral column.
SUMMARY_SCOPE_COLUMNS = frozenset({
    "Field", "Group", "Well", "WellConnection", "WellCompletion",
    "WellLateral", "WellSegment",
    "Region", "Block",
    "AnalyticalAquifer", "AnalyticalAquiferList", "NumericalAquifer",
})


def _summary_size_shape(mnemonic: str) -> tuple[str, Optional[int]]:
    """
    Return ``(size_kind, size_count)`` for a SUMMARY mnemonic.

    Field-scope mnemonics (F-prefix: FOPR, FWPR, …) are written bare with
    no terminating '/' — ``size_kind: 'none'``.

    Every other scope (G/W/C/L/R/B/A/N/S…) takes an optional block whose
    payload is a list of names — well, group, region, completion, …
    — spread freely across one or more lines and closed by a single '/':

        WOPR
          'PROD1'
          'PROD2'
        /

    The body is OPTIONAL: ``WOPR \\n GMWIN \\n /`` (two bare mnemonics
    stacked, single closing '/') is a real and widespread pattern in OPM
    decks. Callers pair ``size_kind: 'array'`` with ``optional_body =
    True`` for these entries so the diagnostics engine skips the
    close-block terminator check when no values were given but still
    flags a forgotten '/' once names are listed.
    """
    if mnemonic.startswith("F"):
        return "none", None
    return "array", None


def _summary_optional_body(mnemonic: str) -> bool:
    """Whether the SUMMARY mnemonic's record body may be omitted entirely."""
    return not mnemonic.startswith("F")


def _parse_performance_table(rows, section_fodt: Path) -> dict:
    """
    Parse the "OPM Flow Simulation Performance" table. Shape is
    ``Variable Description | Variable | Comment`` — the keyword name is
    in column 1 and the long description in column 0. These mnemonics
    (TCPUDAY, ELAPSED, MAXDPR, …) are written bare with no terminating
    '/', so they get ``size_kind: "none"``.
    """
    out: dict = {}
    # Header row identifies column positions
    header = [t.strip() for t, _ in rows[1]]
    try:
        desc_col = header.index("Variable Description")
        var_col = header.index("Variable")
    except ValueError:
        return out
    try:
        cmt_col = header.index("Comment")
    except ValueError:
        cmt_col = None

    for row in rows[2:]:
        cells = [t for t, _ in row]
        if var_col >= len(cells):
            continue
        mnemonic = cells[var_col].strip()
        if not mnemonic or not mnemonic.isupper():
            continue
        description = cells[desc_col].strip() if desc_col < len(cells) else ""
        comment = cells[cmt_col].strip() if cmt_col is not None and cmt_col < len(cells) else ""
        summary = description
        if comment and "No data written" not in comment:
            summary = f"{description} ({comment})" if description else comment
        out[mnemonic] = {
            "name":        mnemonic,
            "section":     "SUMMARY",
            "supported":   None,
            "summary":     summary,
            "description": summary,
            "parameters":  [],
            "examples":    [],
            "full_text":   summary,
            "source_file": str(section_fodt),
            "size_kind":   "none",
        }
    return out


def _parse_control_mode_table(rows, section_fodt: Path) -> dict:
    """
    Parse a "Field and Group Control Mode Reporting" / "Well Control Mode
    Reporting" table. These tables are *transposed* compared to the regular
    mnemonic tables — the mnemonic names live in a single row whose first
    cell is "Mnemonic", and each mnemonic's description is in the next row
    (first cell "Description") where description cells may span multiple
    mnemonic columns.
    """
    out: dict = {}

    def _row_starting_with(label: str):
        for r in rows[1:]:
            if r and r[0][0].strip() == label:
                return r
        return None

    mnem_row = _row_starting_with("Mnemonic")
    desc_row = _row_starting_with("Description")
    if not mnem_row:
        return out

    # Expand the description row into a column-aligned grid so it lines up
    # with the mnemonic row's own column spans (some tables use span=2 to
    # share a description across paired Field/Group mnemonics; others use
    # span=3 to span sub-columns under each mnemonic).
    desc_grid: list[str] = []
    if desc_row:
        for text, span in desc_row[1:]:
            desc_grid.extend([text.strip()] * span)

    # Walk the mnemonic row, advancing a logical-column cursor by each
    # cell's span. The description for a mnemonic is the entry at its
    # *starting* column in the expanded grid.
    col = 0
    pairs: list[tuple[str, str]] = []
    for text, span in mnem_row[1:]:
        mnemonic = text.strip()
        if mnemonic:
            description = desc_grid[col] if col < len(desc_grid) else ""
            pairs.append((mnemonic, description))
        col += span

    for mnemonic, description in pairs:
        if mnemonic in out:
            continue
        size_kind, size_count = _summary_size_shape(mnemonic)
        entry = {
            "name":        mnemonic,
            "section":     "SUMMARY",
            "supported":   None,
            "summary":     description,
            "description": description,
            "parameters":  [],
            "examples":    [],
            "full_text":   description,
            "source_file": str(section_fodt),
            "size_kind":   size_kind,
        }
        if size_count is not None:
            entry["size_count"] = size_count
        if _summary_optional_body(mnemonic):
            entry["optional_body"] = True
        out[mnemonic] = entry
    return out


def parse_summary_mnemonics(section_fodt: Path) -> dict:
    """
    Extract SUMMARY-section mnemonics from the chapter 11 "Data Requirements"
    section file (``parts/chapters/sections/11/2.fodt``).

    Returns ``{NAME: entry}`` using the same shape as ``parse_keyword_file``:
    each entry has ``section="SUMMARY"``, a description sourced from the
    table's "Variable" + "Comment" columns, no parameters, and a
    ``size_kind`` of "none" or "list" so the diagnostics engine knows
    whether to require a terminating '/'.
    """
    parser = etree.XMLParser(recover=True, huge_tree=True)
    try:
        with open(section_fodt, "rb") as f:
            data = f.read()
        root = etree.fromstring(data, parser=parser)
    except (FileNotFoundError, etree.XMLSyntaxError):
        return {}
    if root is None:
        return {}
    body = root.find(f".//{{{NS['office']}}}text")
    if body is None:
        return {}

    out: dict = {}
    for tbl in body.findall(f".//{{{NS['table']}}}table"):
        rows = extract_raw_rows(tbl)
        if len(rows) < 3:
            continue
        title = " ".join(t for t, _ in rows[0]).strip()

        # Control Mode Reporting tables (Field/Group, Well) use a different
        # transposed shape — the mnemonic names live in a single row whose
        # first cell is "Mnemonic" rather than as scope columns in a header.
        if "Control Mode Reporting" in title:
            for name, entry in _parse_control_mode_table(rows, section_fodt).items():
                if name not in out:
                    out[name] = entry
            continue

        # The OPM Flow Simulation Performance table has yet another shape:
        # `Variable Description | Variable | Comment`. The keyword name is
        # in column 1 (TCPUDAY, ELAPSED, MAXDPR, …) and these are all
        # written bare with no terminator.
        if "OPM Flow Simulation Performance" in title:
            for name, entry in _parse_performance_table(rows, section_fodt).items():
                if name not in out:
                    out[name] = entry
            continue

        if not SUMMARY_TABLE_TITLE_RE.search(title):
            continue

        header = {i: t for i, (t, _) in enumerate(rows[1])}
        # A row of column headers is the second row in every mnemonic table.
        # The "Root" column anchors the shape; the performance-counter table
        # and similar non-mnemonic tables don't have it.
        if "Root" not in header.values():
            continue
        var_col = next((i for i, n in header.items() if n == "Variable"), None)
        cmt_col = next((i for i, n in header.items() if n == "Comment"), None)
        scope_cols = [(i, n) for i, n in header.items() if n in SUMMARY_SCOPE_COLUMNS]
        if not scope_cols:
            continue

        for row in rows[2:]:
            cells = [t for t, _ in row]
            def _cell(i):
                return cells[i].strip() if i is not None and i < len(cells) else ""
            variable = _cell(var_col)
            comment = _cell(cmt_col)
            # Tracer mnemonics (FTPR, WTPC, GTIR, …) are templates: the user
            # appends a tracer name from their TRACERS keyword, so the actual
            # deck keyword is e.g. FTPRSEA. The Variable column starts with
            # "Tracer" for every row whose mnemonics need this treatment.
            is_templated = variable.lower().startswith("tracer")
            for col_idx, _ in scope_cols:
                mnemonic = _cell(col_idx)
                if not mnemonic or mnemonic in out:
                    continue
                if comment and variable:
                    summary = f"{variable}. {comment}"
                else:
                    summary = comment or variable
                size_kind, size_count = _summary_size_shape(mnemonic)
                entry = {
                    "name":        mnemonic,
                    "section":     "SUMMARY",
                    "supported":   None,
                    "summary":     summary,
                    "description": summary,
                    "parameters":  [],
                    "examples":    [],
                    "full_text":   summary,
                    "source_file": str(section_fodt),
                    "size_kind":   size_kind,
                }
                if size_count is not None:
                    entry["size_count"] = size_count
                if _summary_optional_body(mnemonic):
                    entry["optional_body"] = True
                if is_templated:
                    entry["templated"] = True
                out[mnemonic] = entry
    return out


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

    # SUMMARY mnemonics live as table rows in chapter 11 section 2 rather
    # than as standalone .fodt files. Merge them without overwriting any
    # existing per-keyword entries.
    summary_fodt = manual_dir / "parts" / "chapters" / "sections" / "11" / "2.fodt"
    if summary_fodt.exists():
        mnemonics = parse_summary_mnemonics(summary_fodt)
        added = 0
        for name, entry in mnemonics.items():
            if name in index:
                continue
            index[name] = entry
            added += 1
        print(f"  SUMMARY    (11.2):  {added} mnemonics added")
    else:
        print(f"  INFO: SUMMARY mnemonics file not found, skipping: {summary_fodt}")

    # Mark known template keywords (TVDP, …) so the diagnostics engine and
    # docs/hover providers accept ``<base><suffix>`` deck tokens.
    for name in TEMPLATE_KEYWORD_NAMES:
        entry = index.get(name)
        if entry is None:
            continue
        targets = entry if isinstance(entry, list) else [entry]
        for e in targets:
            e["templated"] = True

    # Mark keywords whose single record canonically spans multiple lines
    # so per-line missing-'/' diagnostics are suppressed (MESSAGES, …).
    for name in VARIADIC_RECORD_KEYWORDS:
        entry = index.get(name)
        if entry is None:
            continue
        targets = entry if isinstance(entry, list) else [entry]
        for e in targets:
            e["variadic_record"] = True

    # Reclassify list-kind keywords that don't end with a standalone '/'
    # as 'fixed' (size_count = records_meta length) so closeKw doesn't
    # demand a final terminator. VFPPROD/VFPINJ: the trailing variadic
    # record's '/' is the natural end of the block.
    for name in NO_LIST_TERMINATOR_KEYWORDS:
        entry = index.get(name)
        if entry is None:
            continue
        targets = entry if isinstance(entry, list) else [entry]
        for e in targets:
            if e.get("size_kind") != "list":
                continue
            records_meta = e.get("records_meta")
            if records_meta:
                e["size_kind"] = "fixed"
                e["size_count"] = len(records_meta)

    # UDQ SUMMARY mnemonics are documented under placeholder names of the
    # form ``<scope-prefix>UX{2,}`` (FUXXXXXX, WUXXXXXX, …) — the trailing
    # X's stand for the user-defined UDQ name (up to six characters). Real
    # decks write e.g. ``WUWI1`` or ``FUOIL``. Strip the trailing X's so
    # the entry is keyed/named by the prefix alone (``WU``, ``FU``, …) and
    # mark it templated so the standard ``<base>+[A-Z0-9]+`` fallback
    # resolves deck tokens like WUWI1 to the WU template entry.
    # Lazy quantifier on the prefix so ``FUXXXXXX`` splits as ("FU", "XXXXXX"),
    # not ("FUXXXX", "XX"). ``[A-Z]+`` would otherwise consume the X's first.
    udq_placeholder_re = re.compile(r"^([A-Z]+?)X{2,}$")
    udq_renames: list[tuple[str, str]] = []
    for name in list(index.keys()):
        m = udq_placeholder_re.match(name)
        if not m:
            continue
        prefix = m.group(1)
        if prefix in index:
            # Prefix entry already exists from some other path; leave the
            # placeholder alone rather than risk overwriting real data.
            continue
        udq_renames.append((name, prefix))
    for old_name, new_name in udq_renames:
        entry = index.pop(old_name)
        if isinstance(entry, list):
            for e in entry:
                e["name"] = new_name
                e["templated"] = True
        else:
            entry["name"] = new_name
            entry["templated"] = True
        index[new_name] = entry

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
        if primary.get("templated"):
            out_entry["templated"] = True
        if primary.get("variadic_record"):
            out_entry["variadic_record"] = True
        requires = primary.get("requires")
        if requires:
            out_entry["requires"] = requires
        prohibits = primary.get("prohibits")
        if prohibits:
            out_entry["prohibits"] = prohibits
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
        add_directional_variants(index)
        expand_probe_deck_names(index, opm_common_index)
        attach_string_options(index)

    write_json(index, Path(args.output))
    if args.tsv:
        write_summary_tsv(index, Path(args.tsv))
    if args.compact:
        write_compact_json(index, Path(args.compact))
        # Emit the open-ended summary-vector regex families next to the compact
        # index so the extension can recognise UDQ/tracer/water-cut mnemonics
        # that are not enumerated as explicit deck names.
        if args.opm_common_dir:
            patterns = collect_deck_name_regexes(opm_common_index)
            patterns_path = Path(args.compact).with_name("summary_name_patterns.json")
            with open(patterns_path, "w", encoding="utf-8") as f:
                json.dump(patterns, f, separators=(",", ":"), ensure_ascii=False)
            print(f"Wrote summary-vector patterns: {patterns_path} ({len(patterns)} patterns)")


if __name__ == "__main__":
    main()
