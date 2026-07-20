"""
Tests for build_keyword_index.py

Focus areas (per issue):
  - robust extraction of data from LibreOffice (.fodt) source files
  - management of defaulted values
  - management of column headers
  - float/integer value formatting
"""

import json
import sys
import os
import textwrap
from pathlib import Path

import pytest
from lxml import etree

# Make the scripts directory importable
sys.path.insert(0, str(Path(__file__).parent))
from build_keyword_index import (
    all_text,
    cell_text,
    cell_span,
    extract_raw_rows,
    is_param_row,
    is_unit_row,
    parse_param_table,
    parse_keyword_file,
    parse_summary_mnemonics,
    params_to_markdown,
    iter_paragraphs,
    load_opm_common_index,
    merge_opm_common,
    synthesize_opm_only_entries,
    expand_probe_deck_names,
    collect_deck_name_regexes,
    add_directional_variants,
    extract_string_options,
    attach_string_options,
    _opm_item_for_param,
    _classify_size,
    _merge_dialects,
    RAW_TEXT_KEYWORDS,
    _sanitize_lax_json,
    _load_keyword_json,
    _summary_size_shape,
    _summary_optional_body,
    NS,
    SECTION_MAP,
)


# ---------------------------------------------------------------------------
# Helpers to construct minimal ODF XML fragments
# ---------------------------------------------------------------------------

OFFICE_TEXT_NS = NS["office"]
TEXT_NS = NS["text"]
TABLE_NS = NS["table"]

ODF_HEADER = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<office:document-content '
    '  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
    '  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
    '  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
    '  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"'
    '>'
)
ODF_FOOTER = "</office:document-content>"


def _make_fodt(body_content: str) -> bytes:
    """Wrap body_content in a minimal .fodt document."""
    xml = (
        ODF_HEADER
        + '<office:body><office:text>'
        + body_content
        + "</office:text></office:body>"
        + ODF_FOOTER
    )
    return xml.encode("utf-8")


def _p(text: str, style: str = "") -> str:
    style_attr = f' text:style-name="{style}"' if style else ""
    return f"<text:p{style_attr}>{text}</text:p>"


def _h(text: str, level: int = 1) -> str:
    return f'<text:h text:outline-level="{level}">{text}</text:h>'


def _row(*cells: str, spans: list[int] | None = None) -> str:
    """Build a table:table-row from a list of cell text values."""
    result = "<table:table-row>"
    for i, c in enumerate(cells):
        span = spans[i] if spans else 1
        span_attr = (
            f' table:number-columns-spanned="{span}"' if span > 1 else ""
        )
        result += (
            f"<table:table-cell{span_attr}>"
            f"<text:p>{c}</text:p>"
            f"</table:table-cell>"
        )
    result += "</table:table-row>"
    return result


def _table(*rows: str) -> str:
    return "<table:table>" + "".join(rows) + "</table:table>"


def _parse(xml_bytes: bytes):
    return etree.fromstring(xml_bytes)


# ---------------------------------------------------------------------------
# all_text
# ---------------------------------------------------------------------------


class TestAllText:
    def test_simple_paragraph(self):
        root = _parse(_make_fodt(_p("Hello World")))
        body = root.find(f".//{{{OFFICE_TEXT_NS}}}text")
        paras = list(body.iter(f"{{{TEXT_NS}}}p"))
        assert all_text(paras[0]).strip() == "Hello World"

    def test_nested_spans(self):
        xml = _make_fodt(
            "<text:p>"
            "<text:span>Hello </text:span>"
            "<text:span>World</text:span>"
            "</text:p>"
        )
        root = _parse(xml)
        body = root.find(f".//{{{OFFICE_TEXT_NS}}}text")
        para = body.find(f"{{{TEXT_NS}}}p")
        assert all_text(para).strip() == "Hello World"

    def test_mixed_text_and_tail(self):
        xml = _make_fodt(
            "<text:p>Start <text:span>middle</text:span> end</text:p>"
        )
        root = _parse(xml)
        body = root.find(f".//{{{OFFICE_TEXT_NS}}}text")
        para = body.find(f"{{{TEXT_NS}}}p")
        result = all_text(para)
        assert "Start" in result
        assert "middle" in result
        assert "end" in result

    def test_empty_element_returns_empty(self):
        xml = _make_fodt("<text:p></text:p>")
        root = _parse(xml)
        body = root.find(f".//{{{OFFICE_TEXT_NS}}}text")
        para = body.find(f"{{{TEXT_NS}}}p")
        assert all_text(para).strip() == ""


# ---------------------------------------------------------------------------
# iter_paragraphs
# ---------------------------------------------------------------------------


class TestIterParagraphs:
    def test_plain_paragraphs(self):
        xml = _make_fodt(_p("First") + _p("Second"))
        root = _parse(xml)
        body = root.find(f".//{{{OFFICE_TEXT_NS}}}text")
        results = list(iter_paragraphs(body))
        texts = [t for _, _, t in results]
        assert "First" in texts
        assert "Second" in texts

    def test_heading_elements_are_flagged(self):
        xml = _make_fodt(_h("My Heading") + _p("Body text"))
        root = _parse(xml)
        body = root.find(f".//{{{OFFICE_TEXT_NS}}}text")
        results = list(iter_paragraphs(body))
        heading_results = [(is_h, style, t) for is_h, style, t in results if is_h]
        assert len(heading_results) == 1
        assert "My Heading" in heading_results[0][2]

    def test_empty_paragraphs_are_skipped(self):
        xml = _make_fodt(_p("") + _p("   ") + _p("Real content"))
        root = _parse(xml)
        body = root.find(f".//{{{OFFICE_TEXT_NS}}}text")
        results = list(iter_paragraphs(body))
        texts = [t for _, _, t in results]
        assert all(t.strip() for t in texts), "Empty paragraphs should be excluded"


# ---------------------------------------------------------------------------
# extract_raw_rows
# ---------------------------------------------------------------------------


class TestExtractRawRows:
    def _table_elem(self, xml_str: str):
        full = _make_fodt(xml_str)
        root = _parse(full)
        return root.find(f".//{{{TABLE_NS}}}table")

    def test_simple_3_column_table(self):
        xml = _table(_row("A", "B", "C"), _row("1", "2", "3"))
        elem = self._table_elem(xml)
        rows = extract_raw_rows(elem)
        assert len(rows) == 2
        assert [t for t, _ in rows[0]] == ["A", "B", "C"]
        assert [t for t, _ in rows[1]] == ["1", "2", "3"]

    def test_empty_rows_are_skipped(self):
        xml = _table(_row("A", "B"), _row("", ""), _row("1", "2"))
        elem = self._table_elem(xml)
        rows = extract_raw_rows(elem)
        # The all-empty row should be skipped
        assert len(rows) == 2
        assert [t for t, _ in rows[0]] == ["A", "B"]
        assert [t for t, _ in rows[1]] == ["1", "2"]

    def test_column_span_is_recorded(self):
        xml = _table(_row("Wide", "Normal", spans=[2, 1]))
        elem = self._table_elem(xml)
        rows = extract_raw_rows(elem)
        assert len(rows) == 1
        # First cell has span=2, second has span=1
        assert rows[0][0] == ("Wide", 2)
        assert rows[0][1] == ("Normal", 1)

    def test_empty_table_returns_empty_list(self):
        xml = "<table:table></table:table>"
        full = _make_fodt(xml)
        root = _parse(full)
        elem = root.find(f".//{{{TABLE_NS}}}table")
        rows = extract_raw_rows(elem)
        assert rows == []


# ---------------------------------------------------------------------------
# is_param_row / is_unit_row
# ---------------------------------------------------------------------------


class TestRowClassifiers:
    def test_param_row_with_integer_index(self):
        cells = [("1", 1), ("WELL_NAME", 1), ("Well name string", 3), ("None", 1)]
        assert is_param_row(cells) is True

    def test_param_row_with_range_index(self):
        # Grouped record indices like "1-2" are valid
        cells = [("1-2", 1), ("PARAM", 1), ("Description", 3), ("0", 1)]
        assert is_param_row(cells) is True

    def test_non_param_row_header(self):
        cells = [("No.", 1), ("Name", 1), ("Description", 3), ("Default", 1)]
        assert is_param_row(cells) is False

    def test_non_param_row_text(self):
        cells = [("Note:", 1), ("Some note text", 3)]
        assert is_param_row(cells) is False

    def test_unit_row_three_cells(self):
        cells = [("STBD", 1), ("SM3/D", 1), ("SCC/D", 1)]
        assert is_unit_row(cells) is True

    def test_unit_row_not_3_cells(self):
        assert is_unit_row([("STBD", 1), ("SM3/D", 1)]) is False
        assert is_unit_row([("A", 1), ("B", 1), ("C", 1), ("D", 1)]) is False

    def test_unit_row_with_span_is_rejected(self):
        cells = [("STBD", 2), ("SM3/D", 1), ("SCC/D", 1)]
        assert is_unit_row(cells) is False

    def test_unit_row_note_text_is_rejected(self):
        cells = [("Note: something", 1), ("SM3/D", 1), ("SCC/D", 1)]
        assert is_unit_row(cells) is False


# ---------------------------------------------------------------------------
# parse_param_table — extracted from a table element
# ---------------------------------------------------------------------------


class TestParseParamTable:
    def _table_elem(self, xml_str: str):
        full = _make_fodt(xml_str)
        root = _parse(full)
        return root.find(f".//{{{TABLE_NS}}}table")

    def _param_table(self, *param_rows: tuple) -> str:
        """Build a parameter table with a header row and given param rows.

        Each param_row is (index, name, description, default) with optional
        unit row (field, metric, laboratory) as a 7-tuple.
        """
        header = _row("No.", "Name", "Description", "Default")
        body_rows = []
        for row in param_rows:
            if len(row) == 4:
                idx, name, desc, default = row
                body_rows.append(_row(str(idx), name, desc, default))
            elif len(row) == 7:
                idx, name, desc, default, field, metric, lab = row
                body_rows.append(_row(str(idx), name, desc, default))
                body_rows.append(_row(field, metric, lab))
        return _table(header, *body_rows)

    def test_single_param_no_units(self):
        tbl = self._param_table((1, "MXACTNS", "Max action count", "2"))
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        assert len(params) == 1
        assert params[0]["index"] == 1
        assert params[0]["name"] == "MXACTNS"
        assert params[0]["description"] == "Max action count"
        assert params[0]["default"] == "2"
        assert params[0]["units"] == {}

    def test_multiple_params_no_units(self):
        tbl = self._param_table(
            (1, "NWELLS", "Max wells", "100"),
            (2, "NGROUPS", "Max groups", "20"),
            (3, "NAQUAN", "Max aquifer connections", "1"),
        )
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        assert len(params) == 3
        assert params[0]["index"] == 1
        assert params[1]["index"] == 2
        assert params[2]["index"] == 3
        assert params[1]["name"] == "NGROUPS"

    def test_param_with_unit_row(self):
        tbl = self._param_table(
            (1, "FLOWRATE", "Production flow rate", "0.0", "STBD", "SM3/D", "SCC/D")
        )
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        assert len(params) == 1
        assert params[0]["units"] == {
            "field": "STBD",
            "metric": "SM3/D",
            "laboratory": "SCC/D",
        }

    def test_mixed_params_with_and_without_units(self):
        tbl = self._param_table(
            (1, "RATE", "Flow rate", "0", "STBD", "SM3/D", "SCC/D"),
            (2, "STATUS", "Well status", "OPEN"),
        )
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        assert len(params) == 2
        assert params[0]["units"]["field"] == "STBD"
        assert params[1]["units"] == {}

    def test_header_row_is_skipped(self):
        # Header has "No." in first cell — must be ignored
        tbl = self._param_table((1, "X", "Description", "0"))
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        # Should have exactly 1 param — header row not counted
        assert len(params) == 1

    def test_range_index_string_preserved(self):
        header = _row("No.", "Name", "Description", "Default")
        data = _row("1-2", "GROUPED", "A grouped parameter", "0")
        tbl = _table(header, data)
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        assert len(params) == 1
        assert params[0]["index"] == "1-2"

    def test_empty_table_returns_empty_list(self):
        tbl = "<table:table></table:table>"
        full = _make_fodt(tbl)
        root = _parse(full)
        elem = root.find(f".//{{{TABLE_NS}}}table")
        params = parse_param_table(elem)
        assert params == []

    def test_dual_name_row(self):
        # PVTO-style table: "Name" header has span=2; rows can carry one
        # name spanning both (e.g. RS) or two distinct names (PRSS / PRSU).
        header = _row("No.", "Name", "Description", "Default", spans=[1, 2, 3, 1])
        single = _row("1", "RS", "saturated GOR", "None", spans=[1, 2, 3, 1])
        dual   = _row("2", "PRSS", "PRSU", "pressure desc", "None",
                      spans=[1, 1, 1, 3, 1])
        tbl    = _table(header, single, dual)
        elem   = self._table_elem(tbl)
        params = parse_param_table(elem)
        assert len(params) == 2
        assert params[0]["name"] == "RS"
        assert params[0]["description"] == "saturated GOR"
        assert params[0]["default"] == "None"
        assert params[1]["name"] == "PRSS / PRSU"
        assert params[1]["description"] == "pressure desc"
        assert params[1]["default"] == "None"

    def test_multi_record_table(self):
        # WELSEGS-style: rows carry "R-P" indices spanning two records,
        # and the synthetic Name="/" rows that document the record terminator
        # are dropped.
        tbl = self._param_table(
            (   "1-1", "WELNAME", "well name", "None"),
            (   "1-2", "TOPDEP",  "top depth", "None"),
            (   "1-3", "/",       "row terminator", "n/a"),
            (   "2-1", "ISEG1",   "seg 1", "None"),
            (   "2-2", "ISEG2",   "seg 2", "None"),
            (   "2-3", "/",       "row terminator", "n/a"),
        )
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        # synthetic '/' rows dropped → 4 real params
        assert len(params) == 4
        assert [(p["record"], p["index"], p["name"]) for p in params] == [
            (1, 1, "WELNAME"),
            (1, 2, "TOPDEP"),
            (2, 1, "ISEG1"),
            (2, 2, "ISEG2"),
        ]

    def test_single_record_grouped_index_not_record_mode(self):
        # WLIST-style: bare integer rows plus one row "3-52" meaning
        # "positions 3 through 52 are repetitions of WELNAMES". Only one
        # distinct first-slot record number ⇒ NOT record-mode; the index
        # stays as the original string and no `record` field is attached.
        tbl = self._param_table(
            (1,      "WLIST",    "list name",       "None"),
            (2,      "ACTION",   "action verb",     ""),
            ("3-52", "WELNAMES", "repeated names",  ""),
        )
        elem = self._table_elem(tbl)
        params = parse_param_table(elem)
        assert len(params) == 3
        assert params[2]["index"] == "3-52"
        assert "record" not in params[2]


# ---------------------------------------------------------------------------
# parse_keyword_file — full .fodt parsing with a minimal fixture
# ---------------------------------------------------------------------------


class TestParseKeywordFile:
    def _write_fodt(self, tmp_path: Path, name: str, body_content: str) -> Path:
        """Write a minimal .fodt file and return the path."""
        fodt_path = tmp_path / f"{name}.fodt"
        fodt_path.write_bytes(_make_fodt(body_content))
        return fodt_path

    def test_extracts_keyword_name_from_filename(self, tmp_path):
        fodt = self._write_fodt(tmp_path, "WELSPECS", _p("A simple description."))
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert result is not None
        assert result["name"] == "WELSPECS"

    def test_extracts_section(self, tmp_path):
        fodt = self._write_fodt(tmp_path, "WELSPECS", _p("Defines well specifications."))
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert result["section"] == "SCHEDULE"

    def test_summary_is_first_substantial_paragraph(self, tmp_path):
        summary_text = (
            "The WELSPECS keyword defines the basic well data required for each well."
        )
        fodt = self._write_fodt(tmp_path, "WELSPECS", _p(summary_text))
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert result["summary"] == summary_text

    def test_supported_detection_true(self, tmp_path):
        fodt = self._write_fodt(
            tmp_path,
            "WELSPECS",
            _p("This keyword is supported by OPM Flow."),
        )
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert result["supported"] is True

    def test_supported_detection_false(self, tmp_path):
        fodt = self._write_fodt(
            tmp_path,
            "WELSPECS",
            _p("This keyword is not supported by OPM Flow."),
        )
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert result["supported"] is False

    def test_supported_is_none_when_not_mentioned(self, tmp_path):
        fodt = self._write_fodt(
            tmp_path, "WELSPECS", _p("The WELSPECS keyword defines well data.")
        )
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert result["supported"] is None

    def test_example_text_collected(self, tmp_path):
        body = (
            _p("Main description of the keyword. This is a longer text.")
            + _h("Example", level=2)
            + _p("WELSPECS")
            + _p("'WELL-1' 'G1' 10 10 1* OIL /")
        )
        fodt = self._write_fodt(tmp_path, "WELSPECS", body)
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert any(
            "WELL-1" in e or "WELSPECS" in e for e in result["examples"]
        ), f"Expected example text, got: {result['examples']}"

    def test_parameters_extracted_from_table(self, tmp_path):
        header = _row("No.", "Name", "Description", "Default")
        param1 = _row("1", "WNAME", "Well name", "None")
        param2 = _row("2", "GNAME", "Group name", "FIELD")
        tbl = _table(header, param1, param2)
        body = _p("Defines well specifications. A long enough paragraph.") + tbl
        fodt = self._write_fodt(tmp_path, "WELSPECS", body)
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert len(result["parameters"]) == 2
        assert result["parameters"][0]["name"] == "WNAME"
        assert result["parameters"][1]["name"] == "GNAME"

    def test_parameters_with_units_extracted(self, tmp_path):
        header = _row("No.", "Name", "Description", "Default")
        param = _row("1", "RATE", "Production rate", "0.0")
        units = _row("STBD", "SM3/D", "SCC/D")
        tbl = _table(header, param, units)
        body = _p("Flow rate keyword. A long enough paragraph.") + tbl
        fodt = self._write_fodt(tmp_path, "FLOWKEY", body)
        result = parse_keyword_file(fodt, "SCHEDULE")
        assert len(result["parameters"]) == 1
        assert result["parameters"][0]["units"]["field"] == "STBD"
        assert result["parameters"][0]["units"]["metric"] == "SM3/D"
        assert result["parameters"][0]["units"]["laboratory"] == "SCC/D"

    def test_invalid_xml_returns_none(self, tmp_path):
        bad_fodt = tmp_path / "BAD.fodt"
        bad_fodt.write_bytes(b"<not valid xml <<<<")
        result = parse_keyword_file(bad_fodt, "SCHEDULE")
        assert result is None

    def test_full_text_contains_all_paragraphs(self, tmp_path):
        body = _p("First paragraph.") + _p("Second paragraph.") + _p("Third paragraph.")
        fodt = self._write_fodt(tmp_path, "KEYWORD", body)
        result = parse_keyword_file(fodt, "RUNSPEC")
        assert "First paragraph." in result["full_text"]
        assert "Second paragraph." in result["full_text"]
        assert "Third paragraph." in result["full_text"]


# ---------------------------------------------------------------------------
# params_to_markdown
# ---------------------------------------------------------------------------


class TestParamsToMarkdown:
    def test_no_params_returns_empty(self):
        assert params_to_markdown([]) == ""

    def test_params_without_units(self):
        params = [
            {"index": 1, "name": "NWELLS", "description": "Max wells", "units": {}, "default": "100"},
            {"index": 2, "name": "NGROUPS", "description": "Max groups", "units": {}, "default": "20"},
        ]
        md = params_to_markdown(params)
        assert "| No. |" in md
        assert "NWELLS" in md
        assert "NGROUPS" in md
        assert "Field" not in md  # no units column expected

    def test_params_with_units_include_unit_columns(self):
        params = [
            {
                "index": 1,
                "name": "RATE",
                "description": "Rate",
                "units": {"field": "STBD", "metric": "SM3/D", "laboratory": "SCC/D"},
                "default": "0.0",
            }
        ]
        md = params_to_markdown(params)
        assert "Field" in md
        assert "Metric" in md
        assert "Laboratory" in md
        assert "STBD" in md
        assert "SM3/D" in md


# ---------------------------------------------------------------------------
# opm-common merge
# ---------------------------------------------------------------------------


class TestOpmCommonItemLookup:
    def test_int_index_positional(self):
        items = [{"name": "A"}, {"name": "B"}, {"name": "C"}]
        assert _opm_item_for_param(items, 1)["name"] == "A"
        assert _opm_item_for_param(items, 3)["name"] == "C"

    def test_explicit_item_field_wins_over_position(self):
        # WELSPECS-style: explicit "item" field
        items = [{"item": 5, "name": "FIVE"}, {"item": 1, "name": "ONE"}]
        assert _opm_item_for_param(items, 1)["name"] == "ONE"
        assert _opm_item_for_param(items, 5)["name"] == "FIVE"

    def test_range_index_uses_start(self):
        items = [{"name": "A"}, {"name": "B"}]
        assert _opm_item_for_param(items, "1-2")["name"] == "A"

    def test_out_of_range_returns_none(self):
        items = [{"name": "A"}]
        assert _opm_item_for_param(items, 5) is None

    def test_empty_items_returns_none(self):
        assert _opm_item_for_param([], 1) is None

    def test_unparseable_string_returns_none(self):
        assert _opm_item_for_param([{"name": "A"}], "??") is None


class TestLoadOpmCommonIndex:
    @staticmethod
    def _write_kw(base: Path, dialect: str, letter: str, name: str, payload: dict):
        d = base / dialect / letter
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(json.dumps(payload), encoding="utf-8")

    def test_loads_keywords_across_dialects(self, tmp_path):
        self._write_kw(tmp_path, "000_Eclipse100", "W", "WELSPECS", {
            "name": "WELSPECS",
            "sections": ["SCHEDULE"],
            "items": [{"name": "WELL", "value_type": "STRING"}],
        })
        self._write_kw(tmp_path, "900_OPM", "M", "MULTREGT", {
            "name": "MULTREGT", "sections": ["GRID"], "items": []
        })

        idx = load_opm_common_index(tmp_path)
        assert "WELSPECS" in idx
        assert idx["WELSPECS"]["sections"] == ["SCHEDULE"]
        assert idx["WELSPECS"]["items"][0]["value_type"] == "STRING"
        assert "MULTREGT" in idx

    def test_duplicate_dialects_union_their_sections(self, tmp_path):
        # Sections are unioned in dialect-iteration order rather than
        # resolved first-wins: a keyword any dialect accepts in a section is
        # legal there, and dropping one only yields false "not valid in X"
        # warnings. This is TEMPVD's case (PROPS under Eclipse100,
        # PROPS+SOLUTION under Eclipse300).
        for dialect, value in [("000_Eclipse100", "E100"), ("900_OPM", "OPM")]:
            self._write_kw(tmp_path, dialect, "X", "XYZ", {
                "name": "XYZ", "sections": [value], "items": [],
            })
        idx = load_opm_common_index(tmp_path)
        assert idx["XYZ"]["sections"] == ["E100", "OPM"]

    def test_duplicate_dialect_supplies_missing_size(self, tmp_path):
        # The dialect carrying an explicit size states the record count; the
        # one without falls back to items-only (list-kind), which demands a
        # standalone '/'. The sized shape wins.
        self._write_kw(tmp_path, "000_Eclipse100", "X", "XYZ", {
            "name": "XYZ", "sections": ["PROPS"], "items": [{"name": "DEPTH"}],
        })
        self._write_kw(tmp_path, "001_Eclipse300", "X", "XYZ", {
            "name": "XYZ", "sections": ["PROPS", "SOLUTION"],
            "size": {"keyword": "EQLDIMS", "item": "NTEQUL"},
            "items": [{"name": "DATA", "size_type": "ALL"}],
        })
        idx = load_opm_common_index(tmp_path)
        assert idx["XYZ"]["sections"] == ["PROPS", "SOLUTION"]
        assert idx["XYZ"]["size_kind"] == "fixed"
        assert idx["XYZ"]["items"][0]["name"] == "DATA"

    def test_invalid_json_is_skipped(self, tmp_path):
        d = tmp_path / "000_Eclipse100" / "B"
        d.mkdir(parents=True)
        (d / "BAD").write_text("{ not valid json", encoding="utf-8")
        idx = load_opm_common_index(tmp_path)
        assert idx == {}

    def test_loads_requires_and_prohibits(self, tmp_path):
        self._write_kw(tmp_path, "000_Eclipse100", "B", "BRANPROP", {
            "name": "BRANPROP",
            "sections": ["SCHEDULE"],
            "requires": ["NETWORK"],
            "prohibits": ["GRUPNET"],
            "items": [],
        })
        idx = load_opm_common_index(tmp_path)
        assert idx["BRANPROP"]["requires"] == ["NETWORK"]
        assert idx["BRANPROP"]["prohibits"] == ["GRUPNET"]

    def test_title_size_kind_overridden_to_none(self, tmp_path):
        # opm-common describes TITLE as size:1 with a single size_type:ALL
        # STRING item — the generic classifier would call this fixed/1 and
        # the diagnostics engine would then demand a trailing '/' that
        # real decks never write. RAW_TEXT_KEYWORDS forces size_kind=none
        # so 'TITLE\n   BASE MODEL 1' is accepted as-is.
        self._write_kw(tmp_path, "000_Eclipse100", "T", "TITLE", {
            "name": "TITLE",
            "sections": ["RUNSPEC"],
            "size": 1,
            "items": [{"name": "TitleText", "value_type": "STRING",
                       "size_type": "ALL"}],
        })
        idx = load_opm_common_index(tmp_path)
        assert idx["TITLE"]["size_kind"] == "none"
        assert idx["TITLE"]["size_count"] is None

    def test_multiline_comment_is_loaded(self, tmp_path):
        # ROCK / MAPAXES ship a "comment" with raw newlines, which strict
        # JSON rejects. The lenient loader should still pick the keyword up.
        d = tmp_path / "000_Eclipse100" / "R"
        d.mkdir(parents=True)
        (d / "ROCK").write_text(
            '{\n  "name": "ROCK",\n  "sections": ["PROPS"],\n'
            '  "comment" : "\nline one\nline two\n",\n  "items": []\n}\n',
            encoding="utf-8",
        )
        idx = load_opm_common_index(tmp_path)
        assert "ROCK" in idx
        assert idx["ROCK"]["sections"] == ["PROPS"]

    def test_lax_number_literal_is_loaded(self, tmp_path):
        # NETBALAN uses 1.e-01, which JSON requires written as 1.0e-01.
        d = tmp_path / "000_Eclipse100" / "N"
        d.mkdir(parents=True)
        (d / "NETBALAN").write_text(
            '{ "name": "NETBALAN", "sections": ["SCHEDULE"],'
            ' "items": [{ "name": "LIMIT", "value_type": "DOUBLE",'
            ' "default": 1.e-01 }] }',
            encoding="utf-8",
        )
        idx = load_opm_common_index(tmp_path)
        assert "NETBALAN" in idx
        assert idx["NETBALAN"]["items"][0]["default"] == 0.1

    def test_empty_file_is_skipped_without_error(self, tmp_path):
        # REACACT is an empty placeholder file; it should drop out quietly.
        d = tmp_path / "000_Eclipse100" / "R"
        d.mkdir(parents=True)
        (d / "REACACT").write_text("", encoding="utf-8")
        idx = load_opm_common_index(tmp_path)
        assert idx == {}


class TestSanitizeLaxJson:
    def test_escapes_control_chars_inside_strings(self):
        out = _sanitize_lax_json('{ "c": "a\nb\tc" }')
        assert json.loads(out)["c"] == "a\nb\tc"

    def test_fixes_decimal_without_trailing_digit(self):
        assert json.loads(_sanitize_lax_json('{ "v": 1.e-01 }'))["v"] == 0.1

    def test_leaves_dot_inside_strings_alone(self):
        # A literal ".e" sequence inside a string must not be rewritten.
        out = _sanitize_lax_json('{ "c": "see 1.e-01 here", "v": 2.e0 }')
        data = json.loads(out)
        assert data["c"] == "see 1.e-01 here"
        assert data["v"] == 2.0

    def test_well_formed_json_is_unchanged(self):
        src = '{ "a": 1, "b": [1.5, 2.0], "c": "x" }'
        assert json.loads(_sanitize_lax_json(src)) == json.loads(src)


class TestLoadKeywordJson:
    def test_empty_file_returns_none(self, tmp_path):
        p = tmp_path / "EMPTY"
        p.write_text("   \n", encoding="utf-8")
        assert _load_keyword_json(p) is None

    def test_truly_broken_json_still_raises(self, tmp_path):
        p = tmp_path / "BAD"
        p.write_text("{ not valid", encoding="utf-8")
        with pytest.raises(json.JSONDecodeError):
            _load_keyword_json(p)


class TestClassifySize:
    def test_explicit_size_zero_means_none(self):
        assert _classify_size({"size": 0}) == ("none", 0)

    def test_no_size_no_items_means_none(self):
        # Flag-style keywords like METRIC, OIL, WATER
        assert _classify_size({}) == ("none", 0)

    def test_positive_int_size_is_fixed_with_count(self):
        assert _classify_size({"size": 4, "items": [{"name": "X"}]}) == ("fixed", 4)

    def test_dict_size_is_fixed_with_unknown_count(self):
        # Table-driven keywords (size is determined by another keyword's value)
        # have a fixed record count but no trailing standalone '/' terminator,
        # so they must be classified as "fixed", not "list" — otherwise the
        # diagnostics flag legal RSVD/PVDO/etc. blocks as missing terminator.
        opm = {"size": {"keyword": "EQLDIMS", "item": "NTEQUL"}, "items": [{"name": "DATA"}]}
        assert _classify_size(opm) == ("fixed", None)

    def test_string_size_is_list(self):
        # VFPPROD-style: size: "UNKNOWN" — record count is genuinely unbounded.
        opm = {"size": "UNKNOWN", "items": [{"name": "DATA"}]}
        assert _classify_size(opm) == ("list", None)

    def test_merge_dialects_unions_sections(self):
        # TEMPVD: PROPS under Eclipse100, PROPS+SOLUTION under Eclipse300.
        # Keeping only the first dialect flagged legal SOLUTION blocks as
        # "not valid in SOLUTION".
        entry = {"sections": ["PROPS"], "items": [], "records": None,
                 "size_kind": "list", "size_count": None}
        kept = {"sections": ["PROPS"], "items": [{"name": "DEPTH"}]}
        other = {"sections": ["PROPS", "SOLUTION"], "items": [{"name": "DATA"}]}
        _merge_dialects("TEMPVD", entry, kept, other)
        assert entry["sections"] == ["PROPS", "SOLUTION"]

    def test_merge_dialects_prefers_shape_with_explicit_size(self):
        # The dialect declaring a size states its record count; the one
        # without falls back to items-only, i.e. list-kind, which demands a
        # standalone '/' that TEMPVD blocks never write.
        entry = {"sections": ["PROPS"], "items": [{"name": "DEPTH"}],
                 "records": None, "size_kind": "list", "size_count": None}
        kept = {"sections": ["PROPS"], "items": [{"name": "DEPTH"}]}
        other = {
            "sections": ["PROPS"],
            "size": {"keyword": "EQLDIMS", "item": "NTEQUL"},
            "items": [{"name": "DATA", "size_type": "ALL"}],
        }
        _merge_dialects("TEMPVD", entry, kept, other)
        assert entry["size_kind"] == "fixed"
        assert entry["items"] == [{"name": "DATA", "size_type": "ALL"}]

    def test_merge_dialects_keeps_first_shape_when_it_has_the_size(self):
        entry = {"sections": ["PROPS"], "items": [{"name": "A"}], "records": None,
                 "size_kind": "fixed", "size_count": 3}
        kept = {"sections": ["PROPS"], "size": 3, "items": [{"name": "A"}]}
        other = {"sections": ["PROPS"], "items": [{"name": "B"}]}
        _merge_dialects("KW", entry, kept, other)
        assert entry["size_kind"] == "fixed"
        assert entry["size_count"] == 3
        assert entry["items"] == [{"name": "A"}]

    def test_merge_dialects_never_reshapes_a_raw_text_keyword(self):
        raw_kw = next(iter(RAW_TEXT_KEYWORDS))
        entry = {"sections": ["SCHEDULE"], "items": [], "records": None,
                 "size_kind": "none", "size_count": None}
        kept = {"sections": ["SCHEDULE"]}
        other = {"sections": ["SCHEDULE"], "size": 2, "items": [{"name": "X"}]}
        _merge_dialects(raw_kw, entry, kept, other)
        assert entry["size_kind"] == "none"

    def test_special_case_rock_is_fixed(self):
        # ROCK's size is the sentinel "SPECIAL_CASE_ROCK", but the record
        # count is NTPVT (or NTSFUN/NTROCC under ROCKOPTS) — dependent-count,
        # like the dict form. Classifying it as "list" made the diagnostics
        # demand a standalone '/' that no real deck writes, flagging the
        # canonical SPE1 `ROCK\n 14.7 3E-6 /` as missing a terminator.
        opm = {"size": "SPECIAL_CASE_ROCK", "items": [{"name": "PREF"}]}
        assert _classify_size(opm) == ("fixed", None)

    def test_records_with_int_size_is_fixed_count(self):
        # TUNING-style: a fixed multi-record keyword (size=3, 3 records).
        # These do NOT close with a standalone '/'; size_kind must be
        # "fixed" with size_count=size, not "list" — otherwise the
        # diagnostics engine demands a trailing terminator that real
        # decks never write. Issue #12.
        opm = {
            "size": 3,
            "records": [
                [{"name": "A"}], [{"name": "B"}], [{"name": "C"}],
            ],
        }
        assert _classify_size(opm) == ("fixed", 3)

    def test_records_without_int_size_stays_list(self):
        # WELSEGS-style: variadic multi-record (size=None or unset).
        # The trailing record absorbs all remaining rows and the block
        # ends with a standalone '/', so size_kind="list" is correct.
        opm = {
            "records": [
                [{"name": "A"}], [{"name": "B"}],
            ],
        }
        assert _classify_size(opm) == ("list", None)

    def test_items_without_size_default_to_list(self):
        opm = {"items": [{"name": "X"}]}
        assert _classify_size(opm) == ("list", None)

    def test_data_only_keyword_classified_as_array(self):
        # PORO/PERMX/ACTNUM-shaped: a single "data" block with no items.
        # These are cell-property arrays, not record lists; they must be
        # classified as "array" so the runtime skips terminator/arity
        # checks (each value line is not '/'-terminated, and the block
        # has only one '/' at the end of the value stream).
        opm = {"data": {"value_type": "DOUBLE", "dimension": "1"}}
        assert _classify_size(opm) == ("array", None)

    def test_int_data_only_keyword_classified_as_array(self):
        opm = {"data": {"value_type": "INT"}}
        assert _classify_size(opm) == ("array", None)


class TestMergeOpmCommon:
    def _manual_entry(self, sections=("RUNSPEC",), params=None):
        return {
            "name": "ACTDIMS",
            "section": sections[0],
            "supported": True,
            "summary": "Action dims",
            "description": "",
            "parameters": params or [],
            "examples": [],
            "full_text": "",
            "source_file": "",
        }

    def test_sections_replaced_from_opm_common(self):
        index = {"ACTDIMS": self._manual_entry(sections=("PROPS",))}
        opm = {"ACTDIMS": {"sections": ["RUNSPEC"], "items": []}}
        merge_opm_common(index, opm)
        assert index["ACTDIMS"]["sections_opm"] == ["RUNSPEC"]
        assert index["ACTDIMS"]["section"] == "RUNSPEC"

    def test_empty_opm_sections_does_not_clobber(self):
        # RUNSPEC keyword has sections: [] in opm-common — keep manual's
        index = {"RUNSPEC": self._manual_entry(sections=("RUNSPEC",))}
        opm = {"RUNSPEC": {"sections": [], "items": []}}
        merge_opm_common(index, opm)
        assert index["RUNSPEC"]["section"] == "RUNSPEC"
        assert "sections_opm" not in index["RUNSPEC"]

    def test_value_type_and_dimension_attached_to_params(self):
        params = [
            {"index": 1, "name": "MAX_ACTION", "description": "...", "units": {}, "default": "2"},
            {"index": 2, "name": "MAX_LINES",  "description": "...", "units": {}, "default": "50"},
        ]
        index = {"ACTDIMS": self._manual_entry(params=params)}
        opm = {"ACTDIMS": {
            "sections": ["RUNSPEC"],
            "items": [
                {"name": "MAX_ACTION", "value_type": "INT"},
                {"name": "MAX_LINES",  "value_type": "INT", "dimension": "Length"},
            ],
        }}
        merge_opm_common(index, opm)
        merged = index["ACTDIMS"]["parameters"]
        assert merged[0]["value_type"] == "INT"
        assert "dimension" not in merged[0]
        assert merged[1]["value_type"] == "INT"
        assert merged[1]["dimension"] == "Length"

    def test_keywords_without_opm_match_are_unchanged(self):
        params = [{"index": 1, "name": "X", "description": "", "units": {}, "default": ""}]
        index = {"OBSCURE": self._manual_entry(params=params)}
        merge_opm_common(index, {})  # no opm-common entry
        assert "value_type" not in index["OBSCURE"]["parameters"][0]
        assert "sections_opm" not in index["OBSCURE"]

    def test_requires_and_prohibits_copied_from_opm_common(self):
        # AQUCT requires AQUDIMS; BRANPROP requires NETWORK and prohibits GRUPNET.
        index = {"BRANPROP": self._manual_entry(sections=("SCHEDULE",))}
        opm = {"BRANPROP": {
            "sections": ["SCHEDULE"],
            "items": [],
            "requires": ["NETWORK"],
            "prohibits": ["GRUPNET"],
        }}
        merge_opm_common(index, opm)
        assert index["BRANPROP"]["requires"] == ["NETWORK"]
        assert index["BRANPROP"]["prohibits"] == ["GRUPNET"]

    def test_requires_prohibits_omitted_when_absent(self):
        index = {"ACTDIMS": self._manual_entry()}
        opm = {"ACTDIMS": {"sections": ["RUNSPEC"], "items": []}}
        merge_opm_common(index, opm)
        assert "requires" not in index["ACTDIMS"]
        assert "prohibits" not in index["ACTDIMS"]

    def test_requires_prohibits_set_on_all_list_form_entries(self):
        e1 = self._manual_entry(sections=("RUNSPEC",))
        e2 = self._manual_entry(sections=("GRID",))
        index = {"KW": [e1, e2]}
        opm = {"KW": {"sections": ["RUNSPEC", "GRID"], "items": [],
                      "requires": ["DEP"], "prohibits": ["FOE"]}}
        merge_opm_common(index, opm)
        for e in index["KW"]:
            assert e["requires"] == ["DEP"]
            assert e["prohibits"] == ["FOE"]

    def test_merge_handles_list_form_entries(self):
        # Multi-section keywords are stored as a list of entries
        e1 = self._manual_entry(sections=("RUNSPEC",))
        e2 = self._manual_entry(sections=("GRID",))
        e2["section"] = "GRID"
        index = {"INCLUDE": [e1, e2]}
        opm = {"INCLUDE": {"sections": ["RUNSPEC", "GRID", "PROPS"], "items": []}}
        merge_opm_common(index, opm)
        for e in index["INCLUDE"]:
            assert e["sections_opm"] == ["RUNSPEC", "GRID", "PROPS"]

    def test_expected_columns_set_from_items_count(self):
        index = {"WELSPECS": self._manual_entry()}
        opm = {"WELSPECS": {
            "sections": ["SCHEDULE"],
            "items": [{"name": f"i{i}"} for i in range(17)],
        }}
        merge_opm_common(index, opm)
        assert index["WELSPECS"]["expected_columns"] == 17

    def test_expected_columns_omitted_for_empty_items(self):
        # Section-header keywords like RUNSPEC have no items
        index = {"RUNSPEC": self._manual_entry()}
        opm = {"RUNSPEC": {"sections": [], "items": []}}
        merge_opm_common(index, opm)
        assert "expected_columns" not in index["RUNSPEC"]

    def test_expected_columns_omitted_when_item_has_size_type_all(self):
        # RSVD-shaped: a single ALL item (each record is a variable-length
        # depth/Rs table). expected_columns must NOT be emitted, otherwise
        # legal multi-pair records would be mis-flagged as over-arity.
        index = {"RSVD": self._manual_entry(sections=("SOLUTION",))}
        opm = {"RSVD": {
            "sections": ["SOLUTION"],
            "items": [{
                "name": "DATA",
                "size_type": "ALL",
                "dimension": ["Length", "GasDissolutionFactor"],
            }],
        }}
        merge_opm_common(index, opm)
        assert "expected_columns" not in index["RSVD"]

    def test_variadic_record_flag_set_for_all_items(self):
        # RSVD/RVVD/PVDO/PVTO records have items with size_type=ALL and
        # span multiple lines; only the line carrying '/' completes the
        # record. The diagnostics engine reads variadic_record to skip
        # the missing-'/' check on continuation lines.
        index = {"RSVD": self._manual_entry(sections=("SOLUTION",))}
        opm = {"RSVD": {
            "sections": ["SOLUTION"],
            "items": [{"name": "DATA", "size_type": "ALL"}],
        }}
        merge_opm_common(index, opm)
        assert index["RSVD"].get("variadic_record") is True

    def test_variadic_record_flag_not_set_for_fixed_items(self):
        # ACTDIMS-shaped: no size_type=ALL item — variadic_record stays unset.
        index = {"ACTDIMS": self._manual_entry()}
        opm = {"ACTDIMS": {
            "sections": ["RUNSPEC"],
            "items": [{"name": "A"}, {"name": "B"}],
        }}
        merge_opm_common(index, opm)
        assert "variadic_record" not in index["ACTDIMS"]

    def test_missing_manual_items_are_backfilled_from_opm_common(self):
        # COMPDAT-shaped: opm-common has 14 items but the manual only documents 13.
        # The 14th must be appended so column-header generation and hovers
        # have a name and type for that position.
        params = [
            {"index": i, "name": f"P{i}", "description": "", "units": {}, "default": ""}
            for i in range(1, 14)
        ]
        index = {"COMPDAT": self._manual_entry(sections=("SCHEDULE",), params=params)}
        opm = {"COMPDAT": {
            "sections": ["SCHEDULE"],
            "items": [{"name": f"I{i}"} for i in range(1, 14)] + [
                {"name": "PR", "value_type": "DOUBLE", "comment": "Pressure radius"}
            ],
        }}
        merge_opm_common(index, opm)
        merged = index["COMPDAT"]["parameters"]
        assert len(merged) == 14
        assert index["COMPDAT"]["expected_columns"] == 14
        last = merged[-1]
        assert last["index"] == 14
        assert last["name"] == "PR"
        assert last["value_type"] == "DOUBLE"
        assert last["description"] == "Pressure radius"

    def test_records_mode_emits_records_meta_and_groups_params(self):
        # WELSEGS-shaped: opm-common has `records`, manual params carry
        # `record`. Expect records_meta with per-record expected_columns
        # and parameters grouped record-1 first, then record-2.
        params = [
            {"index": 1, "record": 1, "name": "WELL",      "description": "", "units": {}, "default": "None"},
            {"index": 2, "record": 1, "name": "TOPDEP",    "description": "", "units": {}, "default": "None"},
            {"index": 1, "record": 2, "name": "ISEG1",     "description": "", "units": {}, "default": "None"},
            {"index": 2, "record": 2, "name": "ISEG2",     "description": "", "units": {}, "default": "None"},
        ]
        index = {"WELSEGS": self._manual_entry(sections=("SCHEDULE",), params=params)}
        opm = {"WELSEGS": {
            "sections": ["SCHEDULE"],
            "items": [],
            "records": [
                [{"name": "WELL", "value_type": "STRING"},
                 {"name": "TOPDEP", "value_type": "DOUBLE", "dimension": "Length"}],
                [{"name": "ISEG1", "value_type": "INT"},
                 {"name": "ISEG2", "value_type": "INT"},
                 {"name": "BRANCH", "value_type": "INT"}],  # 3rd item missing in manual
            ],
            "size_kind": "list",
            "size_count": None,
        }}
        merge_opm_common(index, opm)
        e = index["WELSEGS"]
        assert e["records_meta"] == [
            {"expected_columns": 2},
            {"expected_columns": 3},
        ]
        # No top-level expected_columns when records_meta is present
        assert "expected_columns" not in e
        # Parameters: 2 from rec 1 + 3 from rec 2 (one backfilled) = 5
        names = [(p["record"], p["index"], p["name"]) for p in e["parameters"]]
        assert names == [
            (1, 1, "WELL"),
            (1, 2, "TOPDEP"),
            (2, 1, "ISEG1"),
            (2, 2, "ISEG2"),
            (2, 3, "BRANCH"),
        ]
        # Type/dimension copied from opm-common
        assert e["parameters"][1]["dimension"] == "Length"

    def test_records_mode_skips_expected_columns_for_size_type_all_records(self):
        # VFPPROD-shaped: record 2 has a single ALL-arity item (FLOW_VALUES)
        # consuming all values — expected_columns must NOT be set for that
        # record so legal long records are not flagged as over-arity.
        params = [
            {"index": 1, "record": 1, "name": "TABLE", "description": "", "units": {}, "default": "None"},
            {"index": 1, "record": 2, "name": "FLOW",  "description": "", "units": {}, "default": ""},
        ]
        index = {"VFPPROD": self._manual_entry(sections=("SCHEDULE",), params=params)}
        opm = {"VFPPROD": {
            "sections": ["SCHEDULE"],
            "items": [],
            "records": [
                [{"name": "TABLE", "value_type": "INT"}],
                [{"name": "FLOW", "value_type": "DOUBLE", "size_type": "ALL"}],
            ],
        }}
        merge_opm_common(index, opm)
        meta = index["VFPPROD"]["records_meta"]
        assert meta[0] == {"expected_columns": 1}
        assert meta[1] == {}  # ALL-arity record has no expected_columns

    def test_grouped_index_blocks_backfill_of_covered_positions(self):
        # A manual param indexed "1-2" covers positions 1 and 2; opm-common
        # items at 1 and 2 must NOT be appended as duplicates.
        params = [
            {"index": "1-2", "name": "GROUPED", "description": "", "units": {}, "default": ""},
            {"index": 3, "name": "P3", "description": "", "units": {}, "default": ""},
        ]
        index = {"VFPPROD": self._manual_entry(sections=("SCHEDULE",), params=params)}
        opm = {"VFPPROD": {
            "sections": ["SCHEDULE"],
            "items": [{"name": "A"}, {"name": "B"}, {"name": "C"}, {"name": "D"}],
        }}
        merge_opm_common(index, opm)
        merged = index["VFPPROD"]["parameters"]
        # 2 manual + 1 backfilled (item 4); items 1, 2, 3 are already covered.
        assert len(merged) == 3
        indices = [p["index"] for p in merged]
        assert "1-2" in indices
        assert 3 in indices
        assert 4 in indices


class TestSynthesizeOpmOnly:
    def test_keywords_only_in_opm_common_get_synthesized(self):
        index: dict = {}
        opm = {
            "PYACTION": {
                "sections": ["SCHEDULE"],
                "items": [
                    {"name": "FILE", "value_type": "STRING"},
                    {"name": "RUN_COUNT", "value_type": "INT", "default": 1},
                ],
            }
        }
        added = synthesize_opm_only_entries(index, opm)
        assert added == 1
        e = index["PYACTION"]
        assert e["name"] == "PYACTION"
        assert e["section"] == "SCHEDULE"
        assert e["expected_columns"] == 2
        assert e["parameters"][0]["name"] == "FILE"
        assert e["parameters"][0]["value_type"] == "STRING"
        assert e["parameters"][1]["default"] == "1"
        assert "OPM Flow keyword" in e["summary"]

    def test_alias_family_containers_are_not_synthesized(self):
        # opm-common schema names that carry deck_names (PROBE families,
        # ENDPOINT_SPECIFIERS, MULT_XYZ, …) are not deck keywords themselves;
        # their deck_names are expanded separately. They must not be added as
        # standalone keywords (else they pollute completions / pass as valid).
        index: dict = {}
        opm = {
            "WELL_PROBE": {
                "sections": ["SUMMARY"],
                "items": [],
                "deck_names": ["WOPR", "WWIP"],
            },
            "PYACTION": {  # a normal OPM-only keyword, no deck_names
                "sections": ["SCHEDULE"],
                "items": [{"name": "FILE", "value_type": "STRING"}],
            },
        }
        added = synthesize_opm_only_entries(index, opm)
        assert added == 1
        assert "WELL_PROBE" not in index
        assert "PYACTION" in index

    def test_already_present_keywords_are_left_alone(self):
        index = {"EXISTING": {"name": "EXISTING", "summary": "kept"}}
        opm = {"EXISTING": {"sections": ["RUNSPEC"], "items": []}}
        added = synthesize_opm_only_entries(index, opm)
        assert added == 0
        assert index["EXISTING"]["summary"] == "kept"

    def test_synthesized_entry_carries_requires_and_prohibits(self):
        # THERMEXR is an OPM-only keyword that prohibits THELCOEF.
        index: dict = {}
        opm = {"THERMEXR": {
            "sections": ["GRID"],
            "items": [],
            "data": {"value_type": "DOUBLE"},
            "prohibits": ["THELCOEF"],
        }}
        synthesize_opm_only_entries(index, opm)
        assert index["THERMEXR"]["prohibits"] == ["THELCOEF"]
        assert "requires" not in index["THERMEXR"]

    def test_synthesized_entry_with_no_items_has_empty_params(self):
        index: dict = {}
        opm = {"BARE": {"sections": ["RUNSPEC"], "items": []}}
        synthesize_opm_only_entries(index, opm)
        assert index["BARE"]["parameters"] == []
        # No items → expected_columns omitted (rather than stored as None)
        assert "expected_columns" not in index["BARE"]

    def test_synthesized_entry_omits_expected_columns_for_size_type_all(self):
        # A synthesized OPM-only keyword whose only item is size_type:ALL
        # is variable-arity per record; expected_columns must not be set.
        index: dict = {}
        opm = {"PYINPUT": {
            "sections": ["SCHEDULE"],
            "items": [{"name": "BODY", "value_type": "STRING", "size_type": "ALL"}],
        }}
        synthesize_opm_only_entries(index, opm)
        assert "expected_columns" not in index["PYINPUT"]

    def test_synthesized_entry_with_no_sections_keeps_empty_list(self):
        # An opm-common entry with no sections (e.g. section-header keywords)
        # should not be silently relabelled to RUNSPEC.
        index: dict = {}
        opm = {"MYSTERY": {"sections": [], "items": [{"name": "X"}]}}
        synthesize_opm_only_entries(index, opm)
        assert index["MYSTERY"]["sections_opm"] == []
        assert index["MYSTERY"]["section"] == ""

    def test_synthesized_records_keyword(self):
        # An OPM-only multi-record keyword: emits records_meta and
        # parameters carry their record number. No top-level
        # expected_columns since each record may have a different arity.
        index: dict = {}
        opm = {"MULTI": {
            "sections": ["SCHEDULE"],
            "items": [],
            "records": [
                [{"name": "A", "value_type": "STRING"}],
                [{"name": "B", "value_type": "INT"},
                 {"name": "C", "value_type": "INT"}],
            ],
        }}
        synthesize_opm_only_entries(index, opm)
        e = index["MULTI"]
        assert e["records_meta"] == [
            {"expected_columns": 1},
            {"expected_columns": 2},
        ]
        assert "expected_columns" not in e
        records = [(p["record"], p["index"], p["name"]) for p in e["parameters"]]
        assert records == [(1, 1, "A"), (2, 1, "B"), (2, 2, "C")]


class TestExtractStringOptions:
    def test_typical_enum_description(self):
        desc = (
            "STATUS should be set to one of the following character strings: "
            "OPEN: the well is open. SHUT: the well is shut. AUTO: auto mode."
        )
        assert extract_string_options(desc, "STATUS") == ["OPEN", "SHUT", "AUTO"]

    def test_excludes_the_param_name_itself(self):
        desc = "TYPE should be one of: GAS: a gas well. OIL: an oil well."
        assert extract_string_options(desc, "TYPE") == ["GAS", "OIL"]

    def test_deduplicates_repeated_tokens(self):
        desc = "OPEN: open well. OPEN: same again. SHUT: closed."
        assert extract_string_options(desc, "STATUS") == ["OPEN", "SHUT"]

    def test_skips_uppercase_words_followed_by_uppercase(self):
        # "VALID: NAMES are listed below" — VALID precedes uppercase, so the
        # lookahead `(?=[a-z])` should reject it as an option.
        desc = "VALID: NAMES are case-sensitive. ON: enabled. OFF: disabled."
        opts = extract_string_options(desc, "X")
        assert "VALID" not in opts
        assert opts == ["ON", "OFF"]

    def test_blocklists_prose_tokens(self):
        desc = "NOTE: an explanatory note. NB: aside. RUN: execute."
        assert extract_string_options(desc, "X") == ["RUN"]

    def test_empty_description_returns_empty(self):
        assert extract_string_options("", "TYPE") == []
        assert extract_string_options(None, "TYPE") == []  # type: ignore


# ---------------------------------------------------------------------------
# parse_summary_mnemonics — extracts FOPR / WOPR / GGOR / … from the
# chapter 11 section 2 mnemonic tables (issue #15)
# ---------------------------------------------------------------------------


class TestTemplateKeywordPostProcessing:
    def test_tvdp_marked_as_templated(self, tmp_path):
        # TVDP exists as a regular keyword .fodt under 10.3, but real decks
        # write TVDPFSEA / TVDPSIGS / TVDPFWT1 — TVDP itself is a template.
        # build_index post-processes the index to set templated=True on
        # TVDP so the diagnostics engine accepts those suffixed tokens.
        ss = tmp_path / "parts" / "chapters" / "subsections" / "10.3"
        ss.mkdir(parents=True)
        (ss / "TVDP.fodt").write_bytes(_make_fodt(
            _p("Define the Initial Equilibration Tracer Saturation versus Depth Functions. "
               "The TVDP keyword must be concatenated with the tracer name.")
        ))
        from build_keyword_index import build_index
        idx = build_index(tmp_path)
        assert idx["TVDP"].get("templated") is True


class TestParseSummaryMnemonics:
    def _write_section_fodt(self, tmp_path: Path, body_content: str) -> Path:
        section_dir = tmp_path / "parts" / "chapters" / "sections" / "11"
        section_dir.mkdir(parents=True)
        fodt = section_dir / "2.fodt"
        fodt.write_bytes(_make_fodt(body_content))
        return fodt

    def _fgwcl_table(self, *data_rows: str) -> str:
        title = _row("Field, Group, Well, Well Connection, and Completion Summary Variables")
        header = _row("Type", "Variable", "Root", "Field", "Group", "Well",
                      "WellConnection", "WellCompletion", "Comment")
        return _table(title, header, *data_rows)

    def test_extracts_field_group_well_mnemonics(self, tmp_path):
        body = self._fgwcl_table(
            _row("Flow", "Oil Production Rate", "OPR",
                 "FOPR", "GOPR", "WOPR", "", "", ""),
        )
        fodt = self._write_section_fodt(tmp_path, body)
        result = parse_summary_mnemonics(fodt)
        assert "FOPR" in result and "GOPR" in result and "WOPR" in result

    def test_field_scope_gets_size_kind_none(self, tmp_path):
        # F-prefix mnemonics are written bare (`FOPR` on a line by itself,
        # no terminating `/`) — that's `size_kind: "none"`.
        body = self._fgwcl_table(
            _row("Flow", "Water Production Rate", "WPR",
                 "FWPR", "", "", "", "", ""),
        )
        fodt = self._write_section_fodt(tmp_path, body)
        entry = parse_summary_mnemonics(fodt)["FWPR"]
        assert entry["size_kind"] == "none"
        assert "size_count" not in entry

    def test_well_and_group_scope_get_size_kind_array(self, tmp_path):
        # Group/well/region/etc. mnemonics take an optional list of names
        # spread across one or more lines and closed by a single '/'. That's
        # ``size_kind: 'array'`` plus ``optional_body: True`` so a bare
        # ``WOPR`` stacked back-to-back with another mnemonic is accepted
        # but a forgotten closing '/' after listed names is still flagged.
        body = self._fgwcl_table(
            _row("Flow", "Gas-Oil Ratio", "GOR",
                 "", "GGOR", "WGOR", "", "", ""),
        )
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        for kw in ("GGOR", "WGOR"):
            assert out[kw]["size_kind"] == "array"
            assert "size_count" not in out[kw]
            assert out[kw]["optional_body"] is True

    def test_skips_empty_scope_cells(self, tmp_path):
        # Only WOPT exists for this row; the empty Field/Group cells must
        # not be emitted as keywords.
        body = self._fgwcl_table(
            _row("Flow", "Oil Production Total", "OPT",
                 "", "", "WOPT", "", "", ""),
        )
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        assert list(out.keys()) == ["WOPT"]

    def test_attaches_summary_section(self, tmp_path):
        body = self._fgwcl_table(
            _row("Flow", "Oil Production Rate", "OPR",
                 "FOPR", "", "", "", "", ""),
        )
        fodt = self._write_section_fodt(tmp_path, body)
        assert parse_summary_mnemonics(fodt)["FOPR"]["section"] == "SUMMARY"

    def test_summary_text_uses_variable_and_comment(self, tmp_path):
        body = self._fgwcl_table(
            _row("Flow", "Oil Production Rate", "OPR",
                 "FOPR", "", "", "", "", "Cumulative when reported."),
        )
        fodt = self._write_section_fodt(tmp_path, body)
        summary = parse_summary_mnemonics(fodt)["FOPR"]["summary"]
        assert "Oil Production Rate" in summary
        assert "Cumulative when reported." in summary

    def test_picks_up_option_specific_tables(self, tmp_path):
        # Option-specific tables (Polymer, Network Model, CO2STORE, …) share
        # the F/G/W/C/L shape and contain real mnemonics users write into
        # decks — they must be parsed too. Issue #15 surfaced GPR as a
        # specific miss from the Network Model table.
        title = _row("Polymer Model Summary Variables")
        header = _row("Type", "Variable", "Root", "Field", "Group", "Well",
                      "WellConnection", "Region", "Block", "Comment")
        data = _row("Flow", "Polymer Concentration", "PC",
                    "FPC", "GPC", "WPC", "", "", "", "")
        body = _table(title, header, data)
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        for kw in ("FPC", "GPC", "WPC"):
            assert kw in out

    def test_picks_up_network_model_gpr(self, tmp_path):
        # Regression: GPR (Group/Node pressure in a production network)
        # lives in the Network Model table — was previously skipped because
        # only the four core titles were allow-listed.
        title = _row("Network Model Summary Variables")
        header = _row("Type", "Variable", "Root", "Field", "Group", "Well",
                      "WellConnection", "Region", "Block")
        data = _row("Pressure", "Group/Node pressure in a production network.",
                    "", "", "GPR", "", "", "", "")
        body = _table(title, header, data)
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        assert "GPR" in out
        assert out["GPR"]["size_kind"] == "array"
        assert "size_count" not in out["GPR"]
        assert out["GPR"]["optional_body"] is True

    def test_tags_tracer_rows_as_templated(self, tmp_path):
        # Tracer mnemonics (FTPR, WTPC, …) are templates — the user appends
        # their tracer name from TRACERS (FTPRSEA, WTPCHTO, …). The build
        # script tags those entries with templated=True so the diagnostics
        # engine can accept ``<template><suffix>`` tokens.
        title = _row("API and Tracer Tracking Summary Variables")
        header = _row("Type", "Variable", "Root", "Field", "Group", "Well",
                      "WellConnection", "Region", "Block")
        tracer_row = _row("Flow", "Tracer Production Rate", "TPR",
                          "FTPR", "GTPR", "WTPR", "CTPR", "", "")
        nontracer_row = _row("Flow", "Oil API", "API",
                             "FAPI", "GAPI", "WAPI", "CAPI", "RAPI", "BAPI")
        body = _table(title, header, tracer_row, nontracer_row)
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        for kw in ("FTPR", "GTPR", "WTPR", "CTPR"):
            assert out[kw].get("templated") is True
        for kw in ("FAPI", "GAPI", "WAPI"):
            assert "templated" not in out[kw]

    def test_picks_up_field_group_control_mode_table(self, tmp_path):
        # The "Field and Group Control Mode Reporting" table is transposed:
        # the mnemonic names live in a single row whose first cell is
        # "Mnemonic" rather than in scope-named columns. Description cells
        # in the next row span across paired Field/Group columns.
        title = _row("Field and Group Control Mode Reporting")
        groups = _row("Object", "Field", "Group", "Field", "Group", "Field", "Group")
        mnem = _row("Mnemonic", "FMCTP", "GMCTP", "FMCTW", "GMCTW", "FMCTG", "GMCTG")
        desc = _row("Description", "Production Group.", "Water Injection Group.",
                    "Gas Injection Group.", spans=[1, 2, 2, 2])
        body = _table(title, groups, mnem, desc)
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        for kw in ("FMCTP", "GMCTP", "FMCTW", "GMCTW", "FMCTG", "GMCTG"):
            assert kw in out
        # Field-scope stays bare; group-scope takes an optional list of names.
        assert out["FMCTP"]["size_kind"] == "none"
        assert out["GMCTP"]["size_kind"] == "array"
        assert "size_count" not in out["GMCTP"]
        assert out["GMCTP"]["optional_body"] is True
        # Description spans pair Field/Group correctly.
        assert "Production Group" in out["FMCTP"]["summary"]
        assert "Production Group" in out["GMCTP"]["summary"]
        assert "Water Injection" in out["FMCTW"]["summary"]
        assert "Gas Injection" in out["FMCTG"]["summary"]

    def test_picks_up_well_control_mode_table(self, tmp_path):
        # The Well variant uses span=3 on each mnemonic so the descriptions
        # align with their starting column, not via 1:1 expansion. Real
        # decks see e.g. WSTAT and WMCTL.
        title = _row("Well Control Mode Reporting")
        groups = _row("Object", "Well", "Well", spans=[1, 3, 3])
        mnem = _row("Mnemonic", "WSTAT", "WMCTL", spans=[1, 3, 3])
        desc = _row("Description", "Well Status indicator.",
                    "Well Mode of Control indicator.", spans=[1, 3, 3])
        body = _table(title, groups, mnem, desc)
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        assert out["WSTAT"]["size_kind"] == "array"
        assert "size_count" not in out["WSTAT"]
        assert out["WSTAT"]["optional_body"] is True
        assert "Well Status" in out["WSTAT"]["summary"]
        assert "Well Mode of Control" in out["WMCTL"]["summary"]
        assert out["WMCTL"]["size_kind"] == "array"
        assert out["WMCTL"]["optional_body"] is True

    def test_picks_up_performance_table(self, tmp_path):
        # The "OPM Flow Simulation Performance" table has a different
        # shape — "Variable Description | Variable | Comment". The
        # keyword name lives in column 1 and these mnemonics are bare
        # (no '/').
        title = _row("OPM Flow Simulation Performance")
        header = _row("Variable Description", "Variable", "Comment")
        data1 = _row("CPU - CPU time per day.", "TCPUDAY", "")
        data2 = _row("Elapsed - Elapsed time in seconds.", "ELAPSED",
                     "No data written to file.")
        body = _table(title, header, data1, data2)
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        assert out["TCPUDAY"]["size_kind"] == "none"
        assert "size_count" not in out["TCPUDAY"]
        assert "CPU time per day" in out["TCPUDAY"]["summary"]
        assert out["ELAPSED"]["size_kind"] == "none"

    def test_ignores_tables_with_no_recognised_shape(self, tmp_path):
        # Tables that are neither core mnemonic shape, nor Control Mode,
        # nor Performance must be skipped (no false-positive entries).
        title = _row("Some Other Table")
        header = _row("Column A", "Column B")
        data = _row("foo", "bar")
        body = _table(title, header, data)
        fodt = self._write_section_fodt(tmp_path, body)
        assert parse_summary_mnemonics(fodt) == {}

    def test_handles_aquifer_and_recovery_table_titles(self, tmp_path):
        aq_title = _row("Aquifer Summary Variables")
        aq_header = _row("Variable", "Root", "Field", "AnalyticalAquifer",
                         "AnalyticalAquiferList", "NumericalAquifer", "Comment")
        aq_data = _row("Aquifer Influx Rate", "QR", "FAQR", "AAQR", "ALQR", "ANQR", "")

        rec_title = _row("Field and Region Summary Recovery Variables")
        rec_header = _row("Type", "Variable", "Root", "Field", "Region", "Comment")
        rec_data = _row("Recovery", "Oil Recovery", "OE", "FOE", "ROE", "")

        body = _table(aq_title, aq_header, aq_data) + _table(rec_title, rec_header, rec_data)
        fodt = self._write_section_fodt(tmp_path, body)
        out = parse_summary_mnemonics(fodt)
        for kw in ("FAQR", "AAQR", "ALQR", "ANQR", "FOE", "ROE"):
            assert kw in out
        assert out["FAQR"]["size_kind"] == "none"
        assert out["AAQR"]["size_kind"] == "array" and out["AAQR"]["optional_body"] is True
        assert out["FOE"]["size_kind"] == "none"
        assert out["ROE"]["size_kind"] == "array" and out["ROE"]["optional_body"] is True


class TestSummarySizeShape:
    def test_field_scope_none(self):
        assert _summary_size_shape("FOPR") == ("none", None)
        assert _summary_size_shape("FWPR") == ("none", None)

    def test_other_scopes_array_optional(self):
        # W/G/R/B/A-prefixed mnemonics take an optional list of names
        # spread across one or more lines and closed by a single '/'.
        for kw in ("WOPR", "WWIR", "GGOR", "ROE", "BPR", "AAQR"):
            assert _summary_size_shape(kw) == ("array", None)
            assert _summary_optional_body(kw) is True


class TestAttachStringOptions:
    def _entry(self, params):
        return {"name": "K", "section": "RUNSPEC", "parameters": params,
                "supported": True, "summary": "", "description": "", "examples": []}

    def test_attaches_only_when_two_or_more_options(self):
        params = [
            {"index": 1, "name": "P1", "value_type": "STRING",
             "description": "P1 should be: GAS: a gas. OIL: oil. WAT: water."},
            {"index": 2, "name": "P2", "value_type": "STRING",
             "description": "P2 takes a free-form string of any length."},
            {"index": 3, "name": "P3", "value_type": "INT",
             "description": "P3: an integer count."},
        ]
        index = {"K": self._entry(params)}
        attached = attach_string_options(index)
        assert attached == 1
        assert index["K"]["parameters"][0]["options"] == ["GAS", "OIL", "WAT"]
        assert "options" not in index["K"]["parameters"][1]
        assert "options" not in index["K"]["parameters"][2]  # not STRING


class TestAddDirectionalVariants:
    def test_emits_xyz_copies_for_base_keywords(self):
        index = {
            "KRNUM": {"name": "KRNUM", "sections": ["GRID"], "size_kind": "array"},
        }
        added = add_directional_variants(index)
        assert added == 3
        for suffix in ("X", "Y", "Z"):
            name = f"KRNUM{suffix}"
            assert name in index
            assert index[name]["name"] == name
            assert index[name]["sections"] == ["GRID"]

    def test_is_a_deep_copy_not_a_shared_reference(self):
        index = {"IMBNUM": {"name": "IMBNUM", "sections": ["REGIONS"]}}
        add_directional_variants(index)
        index["IMBNUMX"]["sections"].append("GRID")
        assert index["IMBNUM"]["sections"] == ["REGIONS"]

    def test_skips_missing_base_and_preexisting_variant(self):
        index = {
            "KRNUM": {"name": "KRNUM", "sections": ["GRID"]},
            "KRNUMX": {"name": "KRNUMX", "sections": ["GRID"], "custom": True},
        }
        added = add_directional_variants(index)
        # KRNUMX already present (kept untouched); only Y and Z added. IMBNUM absent.
        assert added == 2
        assert index["KRNUMX"].get("custom") is True


class TestExpandProbeDeckNames:
    def test_expands_deck_names_into_minimal_entries(self):
        index = {}
        opm = {
            "WELL_PROBE": {
                "sections": ["SUMMARY"],
                "deck_names": ["WOPR", "WWIP", "WGIP"],
                "comment": "Well summary vectors.\nSecond line.",
            }
        }
        added = expand_probe_deck_names(index, opm)
        assert added == 3
        assert index["WWIP"]["name"] == "WWIP"
        assert index["WWIP"]["sections_opm"] == ["SUMMARY"]
        assert index["WWIP"]["summary"] == "Well summary vectors."
        # Each expanded mnemonic is tagged with the family it derives from.
        assert index["WWIP"]["alias_of"] == "WELL_PROBE"
        # No size shape -> no terminator/arity checks downstream.
        assert "size_kind" not in index["WWIP"]

    def test_does_not_overwrite_existing_entries(self):
        index = {"WOPR": {"name": "WOPR", "summary": "from manual"}}
        opm = {"WELL_PROBE": {"sections": ["SUMMARY"], "deck_names": ["WOPR", "WWIP"]}}
        added = expand_probe_deck_names(index, opm)
        assert added == 1
        assert index["WOPR"]["summary"] == "from manual"
        # A pre-existing mnemonic keeps its richer fields but still gains the
        # alias tag so hover can show the family relationship.
        assert index["WOPR"]["alias_of"] == "WELL_PROBE"

    def test_tags_existing_list_valued_entry(self):
        # Multi-section manual entries are stored as a list of dicts; the
        # primary (first) entry must receive the alias tag without error.
        index = {"WOPR": [{"name": "WOPR", "summary": "from manual"}]}
        opm = {"WELL_PROBE": {"sections": ["SUMMARY"], "deck_names": ["WOPR"]}}
        added = expand_probe_deck_names(index, opm)
        assert added == 0
        assert index["WOPR"][0]["alias_of"] == "WELL_PROBE"

    def test_self_referential_deck_name_is_not_tagged(self):
        # IMBNUM/NEXTSTEP list their own name in deck_names; a keyword must not
        # be marked as an alias of itself.
        index = {"IMBNUM": {"name": "IMBNUM", "summary": "real keyword"}}
        opm = {"IMBNUM": {"sections": ["REGIONS"],
                          "deck_names": ["IMBNUM", "IMBNUMX", "IMBNUMY"]}}
        expand_probe_deck_names(index, opm)
        assert "alias_of" not in index["IMBNUM"]
        assert index["IMBNUMX"]["alias_of"] == "IMBNUM"

    def test_existing_alias_tag_is_not_overwritten(self):
        # First family wins when a mnemonic is claimed by more than one family.
        index = {"WOPR": {"name": "WOPR", "alias_of": "ALREADY"}}
        opm = {"WELL_PROBE": {"sections": ["SUMMARY"], "deck_names": ["WOPR"]}}
        expand_probe_deck_names(index, opm)
        assert index["WOPR"]["alias_of"] == "ALREADY"

    def test_collect_deck_name_regexes_dedupes(self):
        opm = {
            "A": {"deck_name_regex": "WU.+"},
            "B": {"deck_name_regex": "WU.+"},
            "C": {"deck_name_regex": "FU.+"},
            "D": {},
        }
        rx = collect_deck_name_regexes(opm)
        assert sorted(rx) == ["FU.+", "WU.+"]
