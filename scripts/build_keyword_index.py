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


def load_opm_common_index(keywords_dir: Path) -> dict:
    """
    Walk the opm-common keywords tree and return a dict keyed by keyword name.

    Each value: {"sections": [...], "items": [...]}. If a keyword appears in
    multiple dialect dirs (uncommon in practice), the first one wins.
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
                out[name] = {
                    "sections": data.get("sections", []),
                    "items":    data.get("items", []),
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


def merge_opm_common(index: dict, opm_common_index: dict) -> None:
    """
    Mutate *index* in place, attaching opm-common authoritative data:

    - sections: replaced with opm-common's list when non-empty
    - expected_columns: count of opm-common items (per record), used by
      the extension to flag records with too many values
    - parameters: each gets optional value_type and dimension copied from
      the matching opm-common item

    Manual entries that have no opm-common counterpart are left unchanged.
    """
    merged_sections = 0
    merged_params = 0
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

        # Per-record expected column count (parser-truth)
        if opm["items"]:
            for e in entries:
                e["expected_columns"] = len(opm["items"])

        # Per-parameter type/dimension
        primary = entries[0]
        for p in primary.get("parameters", []):
            it = _opm_item_for_param(opm["items"], p.get("index"))
            if not it:
                continue
            if "value_type" in it:
                p["value_type"] = it["value_type"]
            if "dimension" in it:
                p["dimension"] = it["dimension"]
            merged_params += 1
    print(f"Merged opm-common: {merged_sections} keywords, {merged_params} parameters")


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
        sections = opm["sections"] or ["RUNSPEC"]
        items = opm["items"]
        params: list[dict] = []
        for i, it in enumerate(items):
            p = {
                "index":       it.get("item", i + 1),
                "name":        it.get("name", f"item{i + 1}"),
                "description": it.get("comment", ""),
                "units":       {},
                "default":     "" if "default" not in it else str(it["default"]),
            }
            if "value_type" in it:
                p["value_type"] = it["value_type"]
            if "dimension" in it:
                p["dimension"] = it["dimension"]
            params.append(p)

        index[name] = {
            "name":        name,
            "section":     sections[0],
            "sections_opm": list(sections),
            "supported":   True,
            "summary":     "(OPM Flow keyword — no reference-manual entry)",
            "description": "",
            "parameters":  params,
            "examples":    [],
            "full_text":   "",
            "source_file": "",
            "expected_columns": len(items) if items else None,
        }
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


def parse_param_table(table_elem) -> list[dict]:
    """
    Parse a keyword parameter table into a list of parameter dicts.

    Each dict has:
        index       – 1-based integer
        name        – parameter name string
        description – full description text
        units       – {"field": ..., "metric": ..., "laboratory": ...} or {}
        default     – default value string (may be empty)
    """
    raw = extract_raw_rows(table_elem)
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

            raw_idx = cells[0][0].strip()
            idx: int | str = int(raw_idx) if raw_idx.isdigit() else raw_idx
            name      = cells[1][0] if len(cells) > 1 else ""
            # description is the cell with span=3 (index 2), default is last
            desc      = cells[2][0] if len(cells) > 2 else ""
            default   = cells[3][0] if len(cells) > 3 else ""

            pending_param = {
                "index":       idx,
                "name":        name,
                "description": desc,
                "units":       {},
                "default":     default,
            }

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

    try:
        with open(fodt_path, "rb") as f:
            data = f.read()
        root = etree.fromstring(data)
    except etree.XMLSyntaxError as e:
        print(f"  WARNING: XML parse error in {fodt_path.name}: {e}", file=sys.stderr)
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
            sections = primary.get("sections_opm") or [e["section"] for e in entry]
        else:
            primary = entry
            sections = entry.get("sections_opm") or [entry["section"]]
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
