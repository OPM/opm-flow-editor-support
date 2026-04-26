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
    params_to_markdown,
    iter_paragraphs,
    load_opm_common_index,
    merge_opm_common,
    synthesize_opm_only_entries,
    _opm_item_for_param,
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

    def test_first_dialect_wins_on_duplicate(self, tmp_path):
        for dialect, value in [("000_Eclipse100", "E100"), ("900_OPM", "OPM")]:
            self._write_kw(tmp_path, dialect, "X", "XYZ", {
                "name": "XYZ", "sections": [value], "items": [],
            })
        idx = load_opm_common_index(tmp_path)
        # E100 is iterated first, so it wins
        assert idx["XYZ"]["sections"] == ["E100"]

    def test_invalid_json_is_skipped(self, tmp_path):
        d = tmp_path / "000_Eclipse100" / "B"
        d.mkdir(parents=True)
        (d / "BAD").write_text("{ not valid json", encoding="utf-8")
        idx = load_opm_common_index(tmp_path)
        assert idx == {}


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

    def test_already_present_keywords_are_left_alone(self):
        index = {"EXISTING": {"name": "EXISTING", "summary": "kept"}}
        opm = {"EXISTING": {"sections": ["RUNSPEC"], "items": []}}
        added = synthesize_opm_only_entries(index, opm)
        assert added == 0
        assert index["EXISTING"]["summary"] == "kept"

    def test_synthesized_entry_with_no_items_has_empty_params(self):
        index: dict = {}
        opm = {"BARE": {"sections": ["RUNSPEC"], "items": []}}
        synthesize_opm_only_entries(index, opm)
        assert index["BARE"]["parameters"] == []
        assert index["BARE"]["expected_columns"] is None
