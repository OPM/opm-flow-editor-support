#!/usr/bin/env python3
"""
build_keyword_site.py

Render the keyword index produced by ``build_keyword_index.py`` as a static
website suitable for GitHub Pages: one page per keyword, plus a front page
listing every keyword with client-side search and section filtering.

Usage:
    python build_keyword_site.py --index keyword_index.json --output site

Only the *full* index carries the fields this site needs (``description``,
``examples``, ``source_file``, ``sections_opm``); the compact index bundled
with the VS Code extension drops them.

The keyword documentation is derived from the OPM Flow reference manual
(https://github.com/OPM/opm-reference-manual), which is licensed CC BY 4.0 —
hence the attribution footer on every generated page.
"""

import argparse
import html
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import quote

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MANUAL_REPO = "https://github.com/OPM/opm-reference-manual"
PROJECT_REPO = "https://github.com/OPM/opm-flow-editor-support"
CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/"

SITE_TITLE = "OPM Flow Keyword Reference"

# Deck sections in the order the manual (and a deck) presents them. The last
# two are OPM/manual internals that show up in a handful of entries.
SECTION_ORDER = (
    "RUNSPEC", "GRID", "EDIT", "PROPS", "REGIONS",
    "SOLUTION", "SUMMARY", "SCHEDULE", "SPECIAL", "SRUNSPEC",
)
SECTION_SET = frozenset(SECTION_ORDER)

# Manual chapter -> deck section, mirroring SECTION_MAP in
# build_keyword_index.py. Duplicated rather than imported so this script does
# not pull in lxml. 93 of the 107 multi-chapter keywords carry the same
# ``section`` value on every variant, so the chapter the .fodt came from is the
# only thing that tells the variants apart.
CHAPTER_SECTIONS = {
    "5.3": "RUNSPEC", "6.3": "GRID", "7.3": "EDIT", "8.3": "PROPS",
    "9.3": "REGIONS", "10.3": "SOLUTION", "11.3": "SUMMARY", "12.3": "SCHEDULE",
}

# Characters allowed in an output filename. Anything else must be mapped by
# ``slug()`` or the build aborts rather than emitting an unreachable page.
SAFE_SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# The manual prefixes most keyword descriptions with a banner listing all eight
# deck sections (an applicability matrix in the .fodt that flattens to plain
# text). It is noise on a web page. Observed 1155 times across 3458 entries,
# always as a run of seven or eight consecutive paragraphs — usually leading,
# but sometimes further in, after extracted reviewer comments or in a long
# multi-part description. The threshold sits well below that and well above any
# run real prose could produce.
MIN_SECTION_BANNER_RUN = 4

# 577 descriptions also contain the parameter table re-serialised as loose
# paragraphs: a "No." / "Name" / ... header, the rows, an optional "Notes:"
# block, then a "Table 12.3.281.1: WELSPECS Keyword Description" caption. The
# rows duplicate the structured ``parameters`` list, so the span is dropped —
# but the "Notes:" block is prose worth keeping.
TABLE_CAPTION_RE = re.compile(r"^Table\s+[\d.]+\s*:")
TABLE_HEADER_START = "No."
TABLE_HEADER_SECOND = "Name"
TABLE_NOTES = "Notes:"

# Length of the summary snippet shown in the front-page listing.
FRONT_PAGE_SUMMARY_CHARS = 140

# Length of the summary stored in the machine-readable search-index.json.
SEARCH_INDEX_SUMMARY_CHARS = 160


# ---------------------------------------------------------------------------
# Data layer
# ---------------------------------------------------------------------------

def load_index(path: Path) -> dict[str, list[dict]]:
    """
    Load keyword_index.json and normalise its two shapes.

    A value is either a single entry dict or a *list* of entry dicts — 107
    keywords are documented in more than one manual chapter (AITS, DEBUG,
    ECHO, END, EOS, ...). Always hand callers a list.
    """
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return {
        name: (value if isinstance(value, list) else [value])
        for name, value in raw.items()
    }


def slug(name: str) -> str:
    """
    Map a keyword name to a URL/filename-safe stem.

    Seven summary vectors end in '+' (RGFR+, EFF+, ...). A literal '+' in a URL
    path is legal but is decoded as a space by enough software to be a real
    risk, so spell it out. Trailing '-' and '_' are safe as-is.
    """
    return name.replace("+", "_PLUS")


def build_slug_map(index: dict[str, list[dict]]) -> dict[str, str]:
    """
    Build name -> slug, aborting on anything that would produce a broken or
    ambiguous URL. GitHub Pages is served from a case-insensitive store in
    practice, so case-folded collisions are fatal too.
    """
    slugs: dict[str, str] = {}
    seen: dict[str, str] = {}
    for name in index:
        s = slug(name)
        if not SAFE_SLUG_RE.match(s):
            sys.exit(f"Keyword {name!r} slugs to {s!r}, which is not filename-safe")
        clash = seen.get(s.casefold())
        if clash is not None:
            sys.exit(f"Keywords {clash!r} and {name!r} both slug to {s!r}")
        seen[s.casefold()] = name
        slugs[name] = s
    return slugs


def entry_sections(entry: dict) -> list[str]:
    """
    Sections a keyword is valid in. ``sections_opm`` comes from opm-common —
    the parser's own source of truth — and is preferred; otherwise fall back to
    the manual chapter the entry was parsed from.
    """
    opm = entry.get("sections_opm")
    if opm:
        return list(opm)
    section = entry.get("section")
    return [section] if section else []


def keyword_sections(entries: list[dict]) -> list[str]:
    """Union of every variant's sections, in deck order."""
    found = {s for entry in entries for s in entry_sections(entry)}
    ordered = [s for s in SECTION_ORDER if s in found]
    return ordered + sorted(found - SECTION_SET)


def is_known_to_parser(entries: list[dict]) -> bool:
    """
    Whether opm-common — the parser's own definitions — knows the keyword.

    ``entry["supported"]`` cannot be used for this: it is set from the first
    match of /(supported|not supported)/ anywhere in the .fodt text, so
    COMPDAT, WELSPECS and WCONPROD are all flagged unsupported because a
    *parameter* description mentions an unsupported option.

    A false result means "no evidence", not "unsupported": 267 of the 288
    entries without either signal are SUMMARY vectors that the parser accepts
    through a regex family rather than a named definition. Callers must not
    render a negative claim from this.
    """
    return any(e.get("sections_opm") or e.get("alias_of") for e in entries)


def variant_section(entry: dict) -> str:
    """
    The deck section a variant documents, taken from the manual chapter its
    .fodt lives in. ``entry["section"]`` is duplicated across variants for most
    multi-chapter keywords, so it cannot tell them apart on its own.
    """
    parts = re.split(r"[\\/]+", entry.get("source_file") or "")
    if len(parts) >= 2:
        section = CHAPTER_SECTIONS.get(parts[-2])
        if section:
            return section
    return entry.get("section") or ""


# ---------------------------------------------------------------------------
# Text layer
# ---------------------------------------------------------------------------

def paragraphs(text: str) -> list[str]:
    """Split flattened .fodt text into its paragraphs."""
    return [p for p in (text or "").split("\n\n")]


def strip_section_banner(text: str) -> str:
    """Drop every run of consecutive paragraphs that are bare section names."""
    parts = paragraphs(text)
    out: list[str] = []
    i = 0
    while i < len(parts):
        if parts[i].strip() not in SECTION_SET:
            out.append(parts[i])
            i += 1
            continue
        run = i
        while run < len(parts) and parts[run].strip() in SECTION_SET:
            run += 1
        if run - i < MIN_SECTION_BANNER_RUN:
            out.extend(parts[i:run])
        i = run
    return "\n\n".join(out)


def strip_flat_param_tables(text: str) -> tuple[str, int]:
    """
    Remove parameter tables that were flattened into the description.

    Each span runs from a "No." paragraph immediately followed by "Name", up to
    and including the "Table N.N: ... Keyword Description" caption. Any
    "Notes:" block inside the span is prose about the keyword itself and is
    kept. A span with no caption is left alone — better a duplicated table than
    a description truncated by a mis-fire.

    Returns the cleaned text and the number of tables removed.
    """
    parts = paragraphs(text)
    out: list[str] = []
    removed = 0
    i = 0
    while i < len(parts):
        is_header = (
            parts[i].strip() == TABLE_HEADER_START
            and i + 1 < len(parts)
            and parts[i + 1].strip() == TABLE_HEADER_SECOND
        )
        if not is_header:
            out.append(parts[i])
            i += 1
            continue

        caption = next(
            (j for j in range(i + 2, len(parts))
             if TABLE_CAPTION_RE.match(parts[j].strip())),
            None,
        )
        if caption is None:
            out.append(parts[i])
            i += 1
            continue

        notes = next(
            (j for j in range(i + 2, caption) if parts[j].strip() == TABLE_NOTES),
            None,
        )
        if notes is not None:
            out.extend(parts[notes:caption])
        removed += 1
        i = caption + 1

    return "\n\n".join(out), removed


def clean_description(entry: dict) -> tuple[str, int]:
    """Apply both description clean-ups. Returns the text and tables removed."""
    return strip_flat_param_tables(strip_section_banner(entry.get("description") or ""))


def manual_url(source_file: str, manual_ref: str) -> Optional[str]:
    """
    Turn the absolute build-machine path in ``source_file`` into a link to the
    .fodt on github.com. 667 entries are opm-common-only and have no source
    file at all.
    """
    if not source_file:
        return None
    parts = re.split(r"[\\/]+", source_file)
    if "opm-reference-manual" not in parts:
        return None
    start = len(parts) - 1 - parts[::-1].index("opm-reference-manual")
    rel = "/".join(parts[start + 1:])
    if not rel:
        return None
    return f"{MANUAL_REPO}/blob/{quote(manual_ref)}/{quote(rel)}"


def manual_path(source_file: str) -> str:
    """The .fodt path relative to the manual root, for display."""
    parts = re.split(r"[\\/]+", source_file or "")
    if "opm-reference-manual" not in parts:
        return ""
    start = len(parts) - 1 - parts[::-1].index("opm-reference-manual")
    return "/".join(parts[start + 1:])


# ---------------------------------------------------------------------------
# HTML helpers
# ---------------------------------------------------------------------------

def esc(value: Any) -> str:
    """HTML-escape, treating None as empty."""
    return html.escape("" if value is None else str(value), quote=True)


def esc_breaks(value: Any) -> str:
    """
    Escape and add <wbr> break opportunities after '/', '_' and '*' so dense
    unit and dimension labels wrap inside narrow table cells instead of forcing
    a horizontal scroll. Same trick as the extension's escWithBreaks.
    """
    return re.sub(r"([/_*])", r"\1<wbr>", esc(value))


def render_paragraphs(text: str) -> str:
    return "".join(
        f"<p>{esc(p.strip())}</p>" for p in paragraphs(text) if p.strip()
    )


def dimension_label(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    return "" if value is None else str(value)


# ---------------------------------------------------------------------------
# Render layer — keyword pages
# ---------------------------------------------------------------------------

class SiteContext:
    """Everything the renderers need that is not the entry itself."""

    def __init__(self, slugs: dict[str, str], manual_ref: str, manual_short: str):
        self.slugs = slugs
        self.manual_ref = manual_ref
        self.manual_short = manual_short

    def keyword_href(self, name: str, prefix: str = "") -> Optional[str]:
        s = self.slugs.get(name)
        return None if s is None else f"{prefix}{quote(s)}.html"


def render_badges(entries: list[dict], ctx: SiteContext) -> str:
    # Only ever a positive claim — see is_known_to_parser on why the absence of
    # a definition is not evidence that OPM Flow rejects the keyword.
    badges = []
    if is_known_to_parser(entries):
        badges.append(
            '<span class="badge badge-yes">Recognised by the OPM Flow parser</span>'
        )
    for section in keyword_sections(entries):
        badges.append(f'<span class="badge badge-section">{esc(section)}</span>')
    if any(e.get("templated") for e in entries):
        badges.append('<span class="badge">Template name</span>')
    return f'<p class="badges">{"".join(badges)}</p>'


def render_deck_syntax(entry: dict) -> str:
    """A definition list describing the record structure the parser expects."""
    kind = entry.get("size_kind")
    shapes = {
        "none": "No records — the keyword stands alone",
        "fixed": "Fixed number of records",
        "list": "One or more records, each terminated by <code>/</code>",
        "array": "An array of values covering the grid",
    }
    rows: list[tuple[str, str]] = []
    if kind in shapes:
        rows.append(("Records", shapes[kind]))
    if entry.get("size_count") is not None and kind == "fixed":
        rows.append(("Record count", esc(entry["size_count"])))

    records_meta = entry.get("records_meta")
    if records_meta:
        counts = ", ".join(
            f"record {i + 1}: {esc(m.get('expected_columns'))}"
            for i, m in enumerate(records_meta)
        )
        rows.append(("Items per record", counts))
    elif entry.get("expected_columns") is not None:
        rows.append(("Items per record", esc(entry["expected_columns"])))

    if entry.get("variadic_record"):
        rows.append(("Variadic", "The record accepts a variable number of items"))
    if entry.get("optional_body"):
        rows.append(("Optional body", "The record block may be omitted"))
    if entry.get("templated"):
        rows.append((
            "Template",
            "The deck keyword is this name with a suffix appended",
        ))

    if not rows:
        return ""
    items = "".join(f"<dt>{esc(k)}</dt><dd>{v}</dd>" for k, v in rows)
    return f'<dl class="deck-syntax">{items}</dl>'


def visible_param_columns(params: list[dict]) -> set[str]:
    """
    Which optional columns carry data. Mirrors the show-flag logic the
    extension uses for its docs sidebar so a column is never rendered empty.
    """
    visible = set()
    for p in params:
        units = p.get("units") or {}
        if p.get("value_type"):
            visible.add("type")
        if dimension_label(p.get("dimension")):
            visible.add("dimension")
        if units.get("field"):
            visible.add("field")
        if units.get("metric"):
            visible.add("metric")
        if units.get("laboratory"):
            visible.add("lab")
        if str(p.get("default") or "").strip():
            visible.add("default")
    return visible


def render_param_rows(params: list[dict], columns: set[str]) -> str:
    rows = []
    for p in params:
        units = p.get("units") or {}
        description = esc(p.get("description"))
        options = p.get("options") or []
        if options:
            chips = "".join(f"<code>{esc(o)}</code>" for o in options)
            description += f'<div class="options">{chips}</div>'
        cells = [
            f'<td class="num">{esc(p.get("index"))}</td>',
            f'<td class="name"><code>{esc(p.get("name"))}</code></td>',
            f"<td>{description}</td>",
        ]
        if "type" in columns:
            cells.append(f'<td>{esc_breaks(p.get("value_type"))}</td>')
        if "dimension" in columns:
            cells.append(f"<td>{esc_breaks(dimension_label(p.get('dimension')))}</td>")
        if "field" in columns:
            cells.append(f'<td>{esc_breaks(units.get("field"))}</td>')
        if "metric" in columns:
            cells.append(f'<td>{esc_breaks(units.get("metric"))}</td>')
        if "lab" in columns:
            cells.append(f'<td>{esc_breaks(units.get("laboratory"))}</td>')
        if "default" in columns:
            cells.append(f'<td>{esc(p.get("default"))}</td>')
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return "".join(rows)


def render_param_table(entry: dict, level: int) -> str:
    """
    The parameter table(s). Keywords with several record types get one table
    per record so it is obvious which group a parameter belongs to.
    """
    params = entry.get("parameters") or []
    if not params:
        return ""
    columns = visible_param_columns(params)
    headers = ['<th class="num">No.</th>', '<th class="name">Name</th>', "<th>Description</th>"]
    for key, label in (
        ("type", "Type"), ("dimension", "Dimension"), ("field", "Field"),
        ("metric", "Metric"), ("lab", "Lab"), ("default", "Default"),
    ):
        if key in columns:
            headers.append(f"<th>{label}</th>")
    head = f"<thead><tr>{''.join(headers)}</tr></thead>"

    def table(rows: str) -> str:
        return f'<div class="table-wrap"><table>{head}<tbody>{rows}</tbody></table></div>'

    out = [f"<h{level}>Parameters</h{level}>"]
    if entry.get("records_meta"):
        buckets: dict[int, list[dict]] = {}
        for p in params:
            buckets.setdefault(p.get("record") or 1, []).append(p)
        for record in sorted(buckets):
            out.append(f"<h{level + 1}>Record {record}</h{level + 1}>")
            out.append(table(render_param_rows(buckets[record], columns)))
    else:
        out.append(table(render_param_rows(params, columns)))
    return "".join(out)


def render_examples(entry: dict, level: int) -> str:
    lines = entry.get("examples") or []
    if not lines:
        return ""
    body = esc("\n".join(lines))
    return f"<h{level}>Example</h{level}><pre><code>{body}</code></pre>"


def render_cross_links(names: Iterable[str], ctx: SiteContext) -> str:
    """Link keyword names that have a page; render the rest as plain code."""
    out = []
    for name in names:
        href = ctx.keyword_href(name)
        out.append(
            f'<a href="{href}"><code>{esc(name)}</code></a>' if href
            else f"<code>{esc(name)}</code>"
        )
    return ", ".join(out)


def render_relations(entry: dict, ctx: SiteContext, level: int) -> str:
    rows = []
    if entry.get("requires"):
        rows.append(("Requires", render_cross_links(entry["requires"], ctx)))
    if entry.get("prohibits"):
        rows.append(("Cannot be combined with", render_cross_links(entry["prohibits"], ctx)))
    if not rows:
        return ""
    items = "".join(f"<dt>{esc(k)}</dt><dd>{v}</dd>" for k, v in rows)
    return f"<h{level}>Related keywords</h{level}><dl>{items}</dl>"


def render_source_link(entry: dict, ctx: SiteContext) -> str:
    url = manual_url(entry.get("source_file") or "", ctx.manual_ref)
    if not url:
        return ""
    path = manual_path(entry.get("source_file") or "")
    return (
        f'<p class="source">Manual source: '
        f'<a href="{esc(url)}"><code>{esc(path)}</code></a></p>'
    )


def render_variant(entry: dict, ctx: SiteContext, level: int) -> str:
    """One manual variant of a keyword: summary, description, params, example."""
    out: list[str] = []

    alias = entry.get("alias_of")
    if alias:
        href = ctx.keyword_href(alias)
        target = f'<a href="{href}"><code>{esc(alias)}</code></a>' if href else f"<code>{esc(alias)}</code>"
        out.append(f'<p class="note">Part of the {target} keyword family in the OPM Flow parser.</p>')

    description, _ = clean_description(entry)
    summary = (entry.get("summary") or "").strip()
    # The description usually opens with the summary verbatim (2790 of 3458
    # entries), so only show the lede when it adds something.
    if summary and not description.strip().startswith(summary):
        out.append(f'<p class="lede">{esc(summary)}</p>')

    if description.strip():
        out.append(render_paragraphs(description))
    elif not summary:
        out.append(
            '<p class="note">This keyword is known to the OPM Flow parser but has '
            "no entry in the reference manual.</p>"
        )

    out.append(render_deck_syntax(entry))
    out.append(render_param_table(entry, level))
    out.append(render_examples(entry, level))
    out.append(render_relations(entry, ctx, level))
    out.append(render_source_link(entry, ctx))
    return "".join(part for part in out if part)


def render_footer(ctx: SiteContext) -> str:
    built = (
        f" Built from <code>opm-reference-manual</code> "
        f"@ <code>{esc(ctx.manual_short)}</code>."
        if ctx.manual_short else ""
    )
    return (
        '<footer><p>Keyword documentation derived from the '
        f'<a href="{MANUAL_REPO}">OPM Flow Reference Manual</a>, '
        f'licensed <a href="{CC_BY_URL}">CC BY 4.0</a>. '
        f'Site generated by <a href="{PROJECT_REPO}">opm-flow-editor-support</a>.'
        f"{built}</p></footer>"
    )


def page_shell(title: str, description: str, body: str, depth: int, ctx: SiteContext) -> str:
    """
    Wrap a body in the common document shell. ``depth`` is how many directory
    levels down the page sits, so asset and home links stay relative and the
    site works at any base path (and over file://).
    """
    up = "../" * depth
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{esc(title)}</title>\n"
        f'<meta name="description" content="{esc(description)}">\n'
        f'<link rel="stylesheet" href="{up}assets/style.css">\n'
        "</head>\n"
        "<body>\n"
        f'<header class="site-header"><a class="home" href="{up}index.html">{esc(SITE_TITLE)}</a></header>\n'
        f"<main>{body}</main>\n"
        f"{render_footer(ctx)}\n"
        "</body>\n"
        "</html>\n"
    )


def render_keyword_page(
    name: str,
    entries: list[dict],
    ctx: SiteContext,
    neighbours: tuple[Optional[str], Optional[str]],
) -> str:
    body = [f"<h1><code>{esc(name)}</code></h1>", render_badges(entries, ctx)]

    if len(entries) == 1:
        body.append(render_variant(entries[0], ctx, level=2))
    else:
        # Same keyword documented in several manual chapters — each variant is
        # real content, so keep them all under their own heading.
        for i, entry in enumerate(entries, start=1):
            section = variant_section(entry) or "manual"
            body.append(
                f'<section class="variant">'
                f"<h2>Variant {i} &mdash; {esc(section)} section</h2>"
                f"{render_variant(entry, ctx, level=3)}"
                f"</section>"
            )

    prev_name, next_name = neighbours
    nav = []
    if prev_name:
        nav.append(f'<a rel="prev" href="{ctx.keyword_href(prev_name)}">&larr; {esc(prev_name)}</a>')
    if next_name:
        nav.append(f'<a rel="next" href="{ctx.keyword_href(next_name)}">{esc(next_name)} &rarr;</a>')
    if nav:
        body.append(f'<nav class="pager">{"".join(nav)}</nav>')

    summary = (entries[0].get("summary") or "").strip()
    return page_shell(
        title=f"{name} — {SITE_TITLE}",
        description=summary[:200],
        body="".join(body),
        depth=1,
        ctx=ctx,
    )


# ---------------------------------------------------------------------------
# Render layer — front page
# ---------------------------------------------------------------------------

def front_page_summary(entries: list[dict]) -> str:
    summary = (entries[0].get("summary") or "").strip().replace("\n", " ")
    if len(summary) <= FRONT_PAGE_SUMMARY_CHARS:
        return summary
    return summary[:FRONT_PAGE_SUMMARY_CHARS].rstrip() + "…"


def render_front_page(index: dict[str, list[dict]], ctx: SiteContext) -> str:
    names = sorted(index)

    used_sections = {s for entries in index.values() for s in keyword_sections(entries)}
    chips = ['<button type="button" class="chip is-active" data-section="ALL">All</button>']
    for section in SECTION_ORDER:
        if section in used_sections:
            chips.append(
                f'<button type="button" class="chip" data-section="{esc(section)}">{esc(section)}</button>'
            )

    letters = sorted({name[0].upper() for name in names})
    jump = "".join(f'<a href="#letter-{esc(l)}">{esc(l)}</a>' for l in letters)

    groups: list[str] = []
    current: Optional[str] = None
    rows: list[str] = []

    def close_group() -> None:
        if current is not None:
            groups.append(
                f'<section class="letter-group" id="letter-{esc(current)}">'
                f'<h2>{esc(current)}</h2><ul class="kw-list">{"".join(rows)}</ul></section>'
            )

    for name in names:
        letter = name[0].upper()
        if letter != current:
            close_group()
            current = letter
            rows = []
        entries = index[name]
        sections = keyword_sections(entries)
        rows.append(
            f'<li class="kw" data-s=" {esc(" ".join(sections))} ">'
            f'<a href="{ctx.keyword_href(name, prefix="keywords/")}">{esc(name)}</a>'
            f'<span class="secs">{esc(", ".join(sections))}</span>'
            f'<span class="sum">{esc(front_page_summary(entries))}</span>'
            f"</li>"
        )
    close_group()

    body = (
        f"<h1>{esc(SITE_TITLE)}</h1>"
        '<p class="lede">Every keyword OPM Flow understands, extracted from the '
        f'<a href="{MANUAL_REPO}">OPM Flow Reference Manual</a> and the '
        'opm-common parser definitions.</p>'
        '<div class="controls">'
        '<input type="search" id="kw-search" placeholder="Search keywords and summaries…" '
        'autocomplete="off" spellcheck="false">'
        f'<div class="chips">{"".join(chips)}</div>'
        f'<p class="count" id="kw-count">{len(names)} keywords</p>'
        "</div>"
        f'<nav class="jump">{jump}</nav>'
        f'{"".join(groups)}'
        '<p class="empty" id="kw-empty" hidden>No keywords match that filter.</p>'
        '<script src="assets/site.js" defer></script>'
    )
    return page_shell(
        title=SITE_TITLE,
        description=f"Searchable reference for all {len(names)} OPM Flow deck keywords.",
        body=body,
        depth=0,
        ctx=ctx,
    )


# ---------------------------------------------------------------------------
# Machine-readable listing
# ---------------------------------------------------------------------------

def build_search_index(index: dict[str, list[dict]]) -> list[list]:
    """A compact [name, sections, summary] listing for external consumers."""
    out = []
    for name in sorted(index):
        entries = index[name]
        summary = (entries[0].get("summary") or "").strip().replace("\n", " ")
        out.append([
            name,
            keyword_sections(entries),
            summary[:SEARCH_INDEX_SUMMARY_CHARS],
        ])
    return out


# ---------------------------------------------------------------------------
# Site assembly
# ---------------------------------------------------------------------------

def write_site(index: dict[str, list[dict]], out_dir: Path, ctx: SiteContext) -> int:
    """Write the whole site. Returns the number of keyword pages written."""
    assets_src = Path(__file__).resolve().parent / "site_assets"

    keywords_dir = out_dir / "keywords"
    keywords_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(assets_src, out_dir / "assets", dirs_exist_ok=True)

    # Tells GitHub Pages not to run the tree through Jekyll, which would drop
    # any future underscore-prefixed path.
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")

    names = sorted(index)
    for i, name in enumerate(names):
        neighbours = (
            names[i - 1] if i > 0 else None,
            names[i + 1] if i + 1 < len(names) else None,
        )
        page = render_keyword_page(name, index[name], ctx, neighbours)
        (keywords_dir / f"{ctx.slugs[name]}.html").write_text(page, encoding="utf-8")

    (out_dir / "index.html").write_text(render_front_page(index, ctx), encoding="utf-8")
    with open(out_dir / "search-index.json", "w", encoding="utf-8") as f:
        json.dump(build_search_index(index), f, separators=(",", ":"), ensure_ascii=False)

    return len(names)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Render keyword_index.json as a static GitHub Pages site"
    )
    parser.add_argument(
        "--index", default="keyword_index.json",
        help="Full keyword index produced by build_keyword_index.py "
             "(default: keyword_index.json). The compact index will not work — "
             "it has no descriptions."
    )
    parser.add_argument(
        "--output", default="site",
        help="Output directory for the generated site (default: site)"
    )
    parser.add_argument(
        "--manual-ref", default="main",
        help="opm-reference-manual commit to point source links at (default: main)"
    )
    args = parser.parse_args()

    index_path = Path(args.index).expanduser().resolve()
    if not index_path.exists():
        sys.exit(f"Keyword index not found: {index_path}")

    index = load_index(index_path)
    slugs = build_slug_map(index)
    ctx = SiteContext(
        slugs=slugs,
        manual_ref=args.manual_ref,
        manual_short=args.manual_ref[:12] if args.manual_ref != "main" else "",
    )

    tables_removed = sum(
        clean_description(entry)[1]
        for entries in index.values() for entry in entries
    )

    out_dir = Path(args.output).expanduser().resolve()
    count = write_site(index, out_dir, ctx)

    print(f"Wrote site: {out_dir}  ({count} keyword pages)")
    print(f"Stripped {tables_removed} flattened parameter tables from descriptions")


if __name__ == "__main__":
    main()
