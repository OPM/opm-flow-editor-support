"""
Tests for build_keyword_site.py

Focus areas:
  - normalising the two shapes keyword_index.json uses
  - URL/filename safety for keyword names containing '+' and '-'
  - the two description clean-ups (section banner, flattened parameter tables)
  - parameter tables: column suppression and per-record grouping
  - link integrity across a generated site
"""

import json
import re
import sys
from pathlib import Path

import pytest

# Make the scripts directory importable
sys.path.insert(0, str(Path(__file__).parent))
from build_keyword_site import (
    SiteContext,
    build_search_index,
    build_slug_map,
    clean_description,
    collect_manual_name_differences,
    entry_sections,
    is_known_to_parser,
    keyword_sections,
    load_index,
    manual_path,
    manual_url,
    render_examples,
    render_front_page,
    render_keyword_page,
    render_manual_names_page,
    render_param_table,
    slug,
    strip_flat_param_tables,
    strip_section_banner,
    variant_section,
    visible_param_columns,
    write_site,
)

SECTION_BANNER = (
    "RUNSPEC\n\nGRID\n\nEDIT\n\nPROPS\n\nREGIONS\n\n"
    "SOLUTION\n\nSUMMARY\n\nSCHEDULE\n\n"
)


def entry(**overrides):
    """A minimally valid index entry."""
    base = {
        "name": "TESTKW",
        "section": "SCHEDULE",
        "supported": None,
        "summary": "A test keyword.",
        "description": "A test keyword.",
        "parameters": [],
        "examples": [],
        "full_text": "",
        "source_file": "",
    }
    base.update(overrides)
    return base


def context(names=("TESTKW",)):
    index = {name: [entry(name=name)] for name in names}
    return SiteContext(build_slug_map(index), manual_ref="main", manual_short="")


# ---------------------------------------------------------------------------
# Data layer
# ---------------------------------------------------------------------------

def test_load_index_normalises_dict_and_list_values(tmp_path):
    path = tmp_path / "index.json"
    path.write_text(json.dumps({
        "SINGLE": entry(name="SINGLE"),
        "MULTI": [entry(name="MULTI", section="RUNSPEC"),
                  entry(name="MULTI", section="SCHEDULE")],
    }), encoding="utf-8")

    index = load_index(path)

    assert isinstance(index["SINGLE"], list) and len(index["SINGLE"]) == 1
    assert len(index["MULTI"]) == 2
    assert [e["section"] for e in index["MULTI"]] == ["RUNSPEC", "SCHEDULE"]


def test_slug_spells_out_plus_and_leaves_dash_alone():
    assert slug("RGFR+") == "RGFR_PLUS"
    assert slug("EFF+") == "EFF_PLUS"
    assert slug("MULTX-") == "MULTX-"
    assert slug("PVT-M") == "PVT-M"
    assert slug("BCABnnn") == "BCABnnn"


def test_build_slug_map_rejects_case_folded_collisions():
    index = {"DEBUG": [entry(name="DEBUG")], "Debug": [entry(name="Debug")]}
    with pytest.raises(SystemExit):
        build_slug_map(index)


def test_build_slug_map_rejects_unsafe_names():
    with pytest.raises(SystemExit):
        build_slug_map({"BAD/NAME": [entry(name="BAD/NAME")]})


def test_entry_sections_prefers_opm_common():
    assert entry_sections(entry(section="RUNSPEC", sections_opm=["GRID", "EDIT"])) == ["GRID", "EDIT"]
    assert entry_sections(entry(section="RUNSPEC")) == ["RUNSPEC"]


def test_keyword_sections_unions_variants_in_deck_order():
    variants = [
        entry(sections_opm=["SCHEDULE"]),
        entry(sections_opm=["RUNSPEC", "SCHEDULE"]),
    ]
    assert keyword_sections(variants) == ["RUNSPEC", "SCHEDULE"]


def test_variant_section_comes_from_the_manual_chapter():
    schedule = entry(section="RUNSPEC",
                     source_file=r"C:\m\opm-reference-manual\parts\chapters\subsections\12.3\AITS.fodt")
    assert variant_section(schedule) == "SCHEDULE"
    # No usable chapter — fall back to whatever the entry claims.
    assert variant_section(entry(section="SPECIAL", source_file="")) == "SPECIAL"


def test_parser_recognition_ignores_the_unreliable_supported_flag():
    # COMPDAT is flagged supported=False by the extractor because a parameter
    # description mentions an unsupported option; opm-common knows it, so the
    # site must still present it as recognised.
    assert is_known_to_parser([entry(supported=False, sections_opm=["SCHEDULE"])])
    assert is_known_to_parser([entry(supported=False, alias_of="WELL_PROBE")])
    assert not is_known_to_parser([entry(supported=True)])


# ---------------------------------------------------------------------------
# Text layer
# ---------------------------------------------------------------------------

def test_strip_section_banner_removes_the_leading_run():
    text = SECTION_BANNER + "The real description.\n\nMore prose."
    assert strip_section_banner(text) == "The real description.\n\nMore prose."


def test_strip_section_banner_leaves_untouched_text_alone():
    text = "The real description.\n\nMore prose."
    assert strip_section_banner(text) == text


def test_strip_section_banner_keeps_a_short_run_of_section_words():
    # A stray section name in prose is not a banner — do not eat real content.
    text = "SCHEDULE\n\nThe real description.\n\nGRID\n\nEDIT\n\nMore prose."
    assert strip_section_banner(text) == text


def test_strip_section_banner_removes_a_banner_further_into_the_text():
    # Three entries (GRUPNET, PIMULTAB, WPAVE) open with reviewer comments
    # extracted from the .fodt, pushing the banner off the front.
    text = "A reviewer comment.\n\n" + SECTION_BANNER + "The real description."
    assert strip_section_banner(text) == "A reviewer comment.\n\nThe real description."


FLAT_TABLE = "\n\n".join([
    "The WELSPECS keyword defines the general well specification data.",
    "No.", "Name", "Description", "Default",
    "1", "WELNAME", "A character string of up to eight characters.", "None",
    "2", "GRPNAME", "The group this well belongs to.", "None",
    "Notes:",
    "The keyword is followed by any number of records.",
    "Table 12.3.281.1: WELSPECS Keyword Description",
    "See also the COMPDAT keyword.",
])


def test_strip_flat_param_tables_keeps_prose_and_notes():
    cleaned, removed = strip_flat_param_tables(FLAT_TABLE)

    assert removed == 1
    assert "The WELSPECS keyword defines" in cleaned
    assert "Notes:" in cleaned
    assert "The keyword is followed by any number of records." in cleaned
    assert "See also the COMPDAT keyword." in cleaned
    # The duplicated rows and the caption are gone.
    assert "WELNAME" not in cleaned
    assert "GRPNAME" not in cleaned
    assert "Table 12.3.281.1" not in cleaned


def test_strip_flat_param_tables_handles_several_tables():
    text = FLAT_TABLE + "\n\n" + FLAT_TABLE
    cleaned, removed = strip_flat_param_tables(text)

    assert removed == 2
    assert "WELNAME" not in cleaned


def test_strip_flat_param_tables_leaves_header_without_caption_alone():
    # No "Table N:" caption means the heuristic cannot find the end of the
    # table; keeping the text is safer than truncating the description.
    text = "Prose.\n\nNo.\n\nName\n\n1\n\nWELNAME\n\nSomething."
    cleaned, removed = strip_flat_param_tables(text)

    assert removed == 0
    assert cleaned == text


def test_clean_description_applies_both_passes():
    cleaned, removed = clean_description(entry(description=SECTION_BANNER + FLAT_TABLE))

    assert removed == 1
    assert not cleaned.startswith("RUNSPEC")
    assert "WELNAME" not in cleaned


def test_manual_url_from_windows_and_posix_paths():
    windows = r"C:\gitroot\opm-flow-editor-support\opm-reference-manual\parts\chapters\subsections\5.3\ACTDIMS.fodt"
    posix = "/home/runner/work/opm-reference-manual/parts/chapters/subsections/5.3/ACTDIMS.fodt"
    expected_tail = "/blob/abc123/parts/chapters/subsections/5.3/ACTDIMS.fodt"

    assert manual_url(windows, "abc123").endswith(expected_tail)
    assert manual_url(posix, "abc123").endswith(expected_tail)
    assert manual_path(windows) == "parts/chapters/subsections/5.3/ACTDIMS.fodt"


def test_manual_url_is_none_without_a_source_file():
    assert manual_url("", "main") is None
    assert manual_url("/somewhere/else/FOO.fodt", "main") is None


# ---------------------------------------------------------------------------
# Parameter tables
# ---------------------------------------------------------------------------

def test_visible_param_columns_only_reports_populated_ones():
    params = [{"index": 1, "name": "A", "description": "d", "units": {}, "default": "", "value_type": "INT"}]
    assert visible_param_columns(params) == {"type"}

    params[0]["units"] = {"field": "ft", "metric": "m", "laboratory": "cm"}
    params[0]["default"] = "3"
    params[0]["dimension"] = "Length"
    assert visible_param_columns(params) == {
        "type", "dimension", "field", "metric", "lab", "default",
    }


def test_param_table_omits_empty_columns():
    html = render_param_table(entry(parameters=[
        {"index": 1, "name": "MXACTNS", "description": "A count.", "units": {},
         "default": "2", "value_type": "INT"},
    ]), level=2)

    assert "<th>Type</th>" in html
    assert "<th>Default</th>" in html
    assert "<th>Field</th>" not in html
    assert "<th>Dimension</th>" not in html


def test_param_table_groups_by_record():
    html = render_param_table(entry(
        records_meta=[{"expected_columns": 2}, {"expected_columns": 3}],
        parameters=[
            {"index": 1, "name": "A", "description": "d", "units": {}, "default": "", "record": 1},
            {"index": 1, "name": "B", "description": "d", "units": {}, "default": "", "record": 2},
        ],
    ), level=2)

    assert "<h3>Record 1</h3>" in html
    assert "<h3>Record 2</h3>" in html
    assert html.count("<table>") == 2


def test_param_table_renders_options_as_chips():
    html = render_param_table(entry(parameters=[
        {"index": 1, "name": "FLAG", "description": "A switch.", "units": {},
         "default": "", "options": ["YES", "NO"]},
    ]), level=2)

    assert '<div class="options">' in html
    assert "<code>YES</code><code>NO</code>" in html


def test_param_table_shows_the_manual_name_when_it_differs():
    html = render_param_table(entry(parameters=[
        {"index": 1, "name": "WELL", "manual_name": "WELNAME", "description": "d",
         "units": {}, "default": ""},
    ]), level=2)

    assert "<code>WELL</code>" in html
    assert '<div class="manual-name">manual: <code>WELNAME</code></div>' in html


def test_param_table_omits_the_manual_name_when_absent():
    html = render_param_table(entry(parameters=[
        {"index": 1, "name": "WELL", "description": "d", "units": {}, "default": ""},
    ]), level=2)

    assert "manual-name" not in html


def test_param_table_joins_list_dimensions():
    html = render_param_table(entry(parameters=[
        {"index": 1, "name": "X", "description": "d", "units": {},
         "default": "", "dimension": ["Density", "1"]},
    ]), level=2)

    assert "Density, 1" in html


def test_param_table_accepts_a_string_index_range():
    html = render_param_table(entry(parameters=[
        {"index": "3-52", "name": "X", "description": "d", "units": {}, "default": ""},
    ]), level=2)

    assert "3-52" in html


# ---------------------------------------------------------------------------
# Page rendering
# ---------------------------------------------------------------------------

def test_description_is_html_escaped():
    page = render_keyword_page(
        "TESTKW",
        [entry(summary="", description='A <b>bold</b> claim & "quotes".')],
        context(),
        (None, None),
    )

    assert "&lt;b&gt;bold&lt;/b&gt;" in page
    assert "&amp;" in page
    assert "<b>bold</b>" not in page


def test_summary_is_not_repeated_when_the_description_opens_with_it():
    summary = "The keyword does a thing."
    page = render_keyword_page(
        "TESTKW",
        [entry(summary=summary, description=summary + "\n\nAnd more detail.")],
        context(),
        (None, None),
    )

    # Once in the description; the other copy is the <meta> description.
    body = page.split("<main>")[1]
    assert body.count(summary) == 1
    assert 'class="lede"' not in body


def test_summary_is_shown_when_the_description_differs():
    page = render_keyword_page(
        "TESTKW",
        [entry(summary="Short form.", description="Quite different prose.")],
        context(),
        (None, None),
    )

    assert 'class="lede"' in page
    assert "Short form." in page


def test_multi_variant_keyword_renders_every_variant():
    # Both entries claim section RUNSPEC — as 93 of the 107 multi-chapter
    # keywords do — so the heading has to come from the .fodt chapter.
    variants = [
        entry(section="RUNSPEC", summary="", description="Runspec flavour.",
              source_file="/m/opm-reference-manual/parts/chapters/subsections/5.3/AITS.fodt"),
        entry(section="RUNSPEC", summary="", description="Schedule flavour.",
              source_file="/m/opm-reference-manual/parts/chapters/subsections/12.3/AITS.fodt"),
    ]
    page = render_keyword_page("AITS", variants, context(("AITS",)), (None, None))

    assert "Variant 1 &mdash; RUNSPEC section" in page
    assert "Variant 2 &mdash; SCHEDULE section" in page
    assert "Runspec flavour." in page
    assert "Schedule flavour." in page


def test_entry_without_manual_text_gets_a_callout():
    page = render_keyword_page(
        "PERMXY",
        [entry(name="PERMXY", summary="", description="", sections_opm=["GRID"])],
        context(("PERMXY",)),
        (None, None),
    )

    assert "no entry in the reference manual" in page


def test_relations_link_only_keywords_that_have_pages():
    ctx = context(("DIFFAGAS", "GAS"))
    page = render_keyword_page(
        "DIFFAGAS",
        [entry(name="DIFFAGAS", requires=["GAS", "WATER"], prohibits=["DIFFCWAT"])],
        ctx,
        (None, None),
    )

    assert '<a href="GAS.html"><code>GAS</code></a>' in page
    assert "<code>WATER</code>" in page
    assert '<a href="WATER.html"' not in page
    assert "<code>DIFFCWAT</code>" in page


def test_alias_note_links_the_family_when_it_has_a_page():
    ctx = context(("WOPR", "WELL_PROBE"))
    page = render_keyword_page("WOPR", [entry(name="WOPR", alias_of="WELL_PROBE")], ctx, (None, None))

    assert 'keyword family' in page
    assert '<a href="WELL_PROBE.html">' in page


def test_alias_note_does_not_link_an_orphan_family():
    ctx = context(("WOPR",))
    page = render_keyword_page("WOPR", [entry(name="WOPR", alias_of="WELL_PROBE")], ctx, (None, None))

    assert "<code>WELL_PROBE</code>" in page
    assert 'href="WELL_PROBE.html"' not in page


def test_examples_are_joined_into_one_block():
    html = render_examples(entry(examples=["ACTDIMS", "2 50 80 3 /"]), level=2)
    assert "<pre><code>ACTDIMS\n2 50 80 3 /</code></pre>" in html
    assert render_examples(entry(examples=[]), level=2) == ""


def test_parser_badge_reflects_opm_common_not_the_supported_flag():
    page = render_keyword_page(
        "COMPDAT",
        [entry(name="COMPDAT", supported=False, sections_opm=["SCHEDULE"])],
        context(("COMPDAT",)),
        (None, None),
    )

    assert "Recognised by the OPM Flow parser" in page


def test_no_negative_parser_claim_without_evidence():
    # RGFR+ and 287 others carry neither signal; most are SUMMARY vectors the
    # parser accepts via a regex family, so the page must stay silent rather
    # than claim they are unsupported.
    page = render_keyword_page(
        "RGFR+", [entry(name="RGFR+", section="SUMMARY")], context(("RGFR+",)), (None, None)
    )

    assert "OPM Flow parser" not in page
    assert "badge-yes" not in page


# ---------------------------------------------------------------------------
# Front page and whole-site assembly
# ---------------------------------------------------------------------------

def test_front_page_lists_every_keyword_with_filter_metadata():
    index = {
        "ACTDIMS": [entry(name="ACTDIMS", sections_opm=["RUNSPEC"])],
        "WOPR": [entry(name="WOPR", sections_opm=["SUMMARY"])],
    }
    page = render_front_page(index, SiteContext(build_slug_map(index), "main", ""))

    assert 'href="keywords/ACTDIMS.html"' in page
    assert 'href="keywords/WOPR.html"' in page
    assert 'data-s=" RUNSPEC "' in page
    assert 'data-section="SUMMARY"' in page
    assert 'id="letter-A"' in page and 'id="letter-W"' in page


# ---------------------------------------------------------------------------
# Manual name differences page
# ---------------------------------------------------------------------------

def _alias_index():
    return {
        "COMPDAT": [entry(name="COMPDAT", parameters=[
            {"index": 1, "name": "WELL", "manual_name": "WELNAME",
             "description": "", "units": {}, "default": ""},
            {"index": 2, "name": "I", "description": "", "units": {}, "default": ""},
        ])],
        "ACTDIMS": [entry(name="ACTDIMS", parameters=[
            {"index": 1, "name": "MAX_ACTION", "manual_name": "MXACTNS",
             "description": "", "units": {}, "default": ""},
        ])],
    }


def test_manual_name_differences_lists_only_renamed_params_sorted():
    rows = collect_manual_name_differences(_alias_index())

    assert [(r["keyword"], r["index"], r["name"], r["manual_name"]) for r in rows] == [
        ("ACTDIMS", 1, "MAX_ACTION", "MXACTNS"),
        ("COMPDAT", 1, "WELL", "WELNAME"),
    ]


def test_manual_name_differences_sorts_by_record_then_item():
    index = {"WELSEGS": [entry(name="WELSEGS", parameters=[
        {"index": 2, "record": 2, "name": "B", "manual_name": "b",
         "description": "", "units": {}, "default": ""},
        {"index": 1, "record": 1, "name": "A", "manual_name": "a",
         "description": "", "units": {}, "default": ""},
        {"index": 1, "record": 2, "name": "C", "manual_name": "c",
         "description": "", "units": {}, "default": ""},
    ])]}

    rows = collect_manual_name_differences(index)

    assert [r["name"] for r in rows] == ["A", "C", "B"]


def test_manual_name_differences_dedupes_repeated_variants():
    # A keyword documented in two manual chapters carries the same parameter
    # list on each variant — the overview must list it once.
    param = {"index": 1, "name": "WELL", "manual_name": "WELNAME",
             "description": "", "units": {}, "default": ""}
    index = {"COMPDAT": [
        entry(name="COMPDAT", section="GRID", parameters=[dict(param)]),
        entry(name="COMPDAT", section="SCHEDULE", parameters=[dict(param)]),
    ]}

    assert len(collect_manual_name_differences(index)) == 1


def test_manual_names_page_renders_rows_and_links_to_keywords():
    index = _alias_index()
    rows = collect_manual_name_differences(index)
    ctx = SiteContext(build_slug_map(index), manual_ref="main", manual_short="")

    page = render_manual_names_page(rows, ctx)

    assert page.count('<tr class="alias">') == 2
    assert '<a href="keywords/COMPDAT.html">COMPDAT</a>' in page
    assert "<code>WELL</code>" in page and "<code>WELNAME</code>" in page
    assert "2 parameters across 2 keywords" in page
    # The record-less rows show a bare item number.
    assert '<td class="num">1</td>' in page


def test_manual_names_page_shows_record_qualified_item_numbers():
    index = {"WELSEGS": [entry(name="WELSEGS", parameters=[
        {"index": 3, "record": 2, "name": "SEGMENT", "manual_name": "SEGNO",
         "description": "", "units": {}, "default": ""},
    ])]}
    rows = collect_manual_name_differences(index)
    ctx = SiteContext(build_slug_map(index), manual_ref="main", manual_short="")

    assert '<td class="num">2-3</td>' in render_manual_names_page(rows, ctx)


def test_front_page_links_to_the_manual_names_page():
    index = _alias_index()
    ctx = SiteContext(build_slug_map(index), manual_ref="main", manual_short="")

    page = render_front_page(index, ctx, manual_name_count=2)

    assert 'href="manual-names.html"' in page
    assert "2 parameters" in page


def test_front_page_omits_the_link_when_nothing_differs():
    index = {"ACTDIMS": [entry(name="ACTDIMS")]}
    ctx = SiteContext(build_slug_map(index), manual_ref="main", manual_short="")

    assert "manual-names.html" not in render_front_page(index, ctx)


def test_search_index_is_compact_and_sorted():
    index = {
        "WOPR": [entry(name="WOPR", summary="x" * 500, sections_opm=["SUMMARY"])],
        "ACTDIMS": [entry(name="ACTDIMS", sections_opm=["RUNSPEC"])],
    }
    rows = build_search_index(index)

    assert [r[0] for r in rows] == ["ACTDIMS", "WOPR"]
    assert rows[1][1] == ["SUMMARY"]
    assert len(rows[1][2]) == 160


def test_build_site_end_to_end_and_every_internal_link_resolves(tmp_path):
    index = {
        "ACTDIMS": [entry(name="ACTDIMS", sections_opm=["RUNSPEC"], parameters=[
            {"index": 1, "name": "MAX_ACTION", "manual_name": "MXACTNS",
             "description": "A count.", "units": {}, "default": "2",
             "value_type": "INT"},
        ])],
        "RGFR+": [entry(name="RGFR+", section="SUMMARY", alias_of="ACTDIMS")],
        "MULTX-": [entry(name="MULTX-", sections_opm=["GRID"])],
        "WELSEGS": [entry(name="WELSEGS", sections_opm=["SCHEDULE"], examples=["WELSEGS", "OP01 /"])],
    }
    ctx = SiteContext(build_slug_map(index), manual_ref="deadbeef", manual_short="deadbeef")

    written = write_site(index, tmp_path, ctx)

    assert written == 4
    assert (tmp_path / "index.html").exists()
    assert (tmp_path / "manual-names.html").exists()
    assert (tmp_path / ".nojekyll").exists()
    assert (tmp_path / "assets" / "style.css").exists()
    assert (tmp_path / "assets" / "site.js").exists()
    assert (tmp_path / "keywords" / "RGFR_PLUS.html").exists()
    assert (tmp_path / "keywords" / "MULTX-.html").exists()
    json.loads((tmp_path / "search-index.json").read_text(encoding="utf-8"))

    href_re = re.compile(r'(?:href|src)="([^"]+)"')
    checked = 0
    for page in tmp_path.rglob("*.html"):
        for href in href_re.findall(page.read_text(encoding="utf-8")):
            if href.startswith(("http://", "https://", "#", "mailto:")):
                continue
            target = (page.parent / href.split("#")[0]).resolve()
            assert target.exists(), f"{page.name} links to missing {href}"
            checked += 1
    assert checked > 0
