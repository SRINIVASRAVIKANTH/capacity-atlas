"""Static checks for the web map: every referenced file exists and the colors stay in sync."""

import re
from html.parser import HTMLParser
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"


PAGES = ("index.html", "solar.html", "terms.html")


def test_every_local_file_referenced_by_the_pages_exists():
    for page in PAGES:
        html = (WEB / page).read_text(encoding="utf-8")
        refs = [r for r in re.findall(r'(?:src|href)="([^"#:]+)"', html) if r != "./"]
        assert refs, f"no local references found in {page}"
        missing = [r for r in refs if not (WEB / r).exists()]
        assert not missing, f"missing files in {page}: {missing}"


def test_every_font_in_the_stylesheet_exists():
    css = (WEB / "style.css").read_text(encoding="utf-8")
    fonts = re.findall(r'url\("([^"]+\.woff2)"\)', css)
    assert len(fonts) == 7
    assert all((WEB / f).exists() for f in fonts)


def _palette(js, name):
    block = re.search(name + r": \{([^}]*)\}", js).group(1)
    return dict(re.findall(r'(c\d|none): "(#[0-9a-fA-F]{6})"', block))


def test_map_colors_match_the_legend_colors():
    css = (WEB / "style.css").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    css_colors = dict(re.findall(r"--(c\d|none):\s*(#[0-9a-fA-F]{6})", css))
    assert css_colors and css_colors == _palette(js, "plasma")


def test_every_palette_has_every_band():
    js = (WEB / "app.js").read_text(encoding="utf-8")
    keys = {"c0", "c1", "c2", "c3", "c4", "c5", "none"}
    assert set(_palette(js, "plasma")) == keys
    assert set(_palette(js, "cividis")) == keys


def test_both_map_pages_switch_to_each_other_and_share_their_parts():
    for page, here, there in (("index.html", "./", "solar.html"), ("solar.html", "solar.html", "./")):
        html = (WEB / page).read_text(encoding="utf-8")
        modes = re.search(r'<nav class="modes"[^>]*>(.*?)</nav>', html, re.S).group(1)
        assert re.search(rf'<a href="{re.escape(here)}" aria-current="page">', modes), page
        assert f'<a href="{there}">' in modes, page
        scripts = re.findall(r'<script src="([^"]+)"', html)
        assert scripts.index("config.js") < scripts.index("kit.js") < scripts.index("built.js"), page
        assert re.findall(r'name="theme" value="(\w+)"', html) == ["auto", "light", "dark"], page
    # Volta is on both pages: the same chat (volta.js), loaded before each page's own script.
    for page, script in (("index.html", "app.js"), ("solar.html", "solar.js")):
        html = (WEB / page).read_text(encoding="utf-8")
        scripts = re.findall(r'<script src="([^"]+)"', html)
        assert scripts.index("kit.js") < scripts.index("volta.js") < scripts.index(script), page
        for part in ("assistant", "assistant-toggle", "assistant-panel", "chat-log", "chat-form", "chat-input", "greeting"):
            assert f'id="{part}"' in html, f"{part} missing from {page}"


def test_display_choices_match_the_code():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    themes = re.findall(r'name="theme" value="(\w+)"', html)
    palettes = re.findall(r'name="palette" value="(\w+)"', html)
    assert themes == ["auto", "light", "dark"]
    assert all(p + ": {" in js for p in palettes) and palettes
    config = (WEB / "config.js").read_text(encoding="utf-8")
    assert "dark:" in config and "light:" in config


def test_site_text_follows_the_copy_rules():
    for name in ("index.html", "app.js", "solar.html", "solar.js", "built.js", "kit.js", "terms.html", "terms.js"):
        assert "—" not in (WEB / name).read_text(encoding="utf-8"), f"em dash in {name}"


def test_data_url_has_no_trailing_slash():
    config = (WEB / "config.js").read_text(encoding="utf-8")
    url = re.search(r'dataUrl:\s*"([^"]+)"', config).group(1)
    assert url.startswith("https://") and not url.endswith("/")


def test_search_service_is_https():
    config = (WEB / "config.js").read_text(encoding="utf-8")
    url = re.search(r'searchUrl:\s*"([^"]+)"', config).group(1)
    assert url.startswith("https://")


def test_every_id_the_script_uses_exists_in_the_page():
    # ids the scripts build inside the detail card at runtime
    created_by_script = {"zoom-feeder", "copy-link", "site-line", "site-share", "trend-toggle", "section-history",
                         "feeder-facts", "section-facts", "to-capacity", "zip-link"}
    for page, script in (("index.html", "app.js"), ("solar.html", "solar.js")):
        html = (WEB / page).read_text(encoding="utf-8")
        js = (WEB / script).read_text(encoding="utf-8")
        ids = set(re.findall(r'\$\("([a-z][a-z0-9-]*)"\)', js))
        missing = sorted(i for i in ids - created_by_script if f'id="{i}"' not in html)
        assert not missing, f"ids used in {script} but missing from {page}: {missing}"


def _csp() -> dict[str, list[str]]:
    text = (WEB / "_headers").read_text(encoding="utf-8")
    policy = re.search(r"Content-Security-Policy:\s*(.+)", text).group(1)
    return {d.split()[0]: d.split()[1:] for d in (p.strip() for p in policy.split(";")) if d}


class _InlineCode(HTMLParser):
    """Finds script tags without a src and on... event attributes, the way a browser reads the page."""

    def __init__(self):
        super().__init__()
        self.found: list[str] = []

    def handle_starttag(self, tag, attrs):
        names = {name for name, _ in attrs}  # HTMLParser gives tag and attribute names in lowercase
        if tag == "script" and "src" not in names:
            self.found.append("<script> without src")
        self.found += [f"<{tag} {name}=...>" for name in sorted(names) if name.startswith("on")]


def test_pages_have_no_inline_scripts_so_the_policy_can_forbid_them():
    for page in PAGES:
        finder = _InlineCode()
        finder.feed((WEB / page).read_text(encoding="utf-8"))
        assert not finder.found, f"inline code in {page}: {finder.found}"
    assert _csp()["script-src"] == ["'self'"]


def test_the_inline_code_finder_catches_what_a_browser_would_run():
    for bad in ("<script>x()</script>", "<SCRIPT >x()</SCRIPT>", '<img src="a" ONERROR="x()">',
                "<script\ntype=module>x()</script>", '<button onclick="x()">'):
        finder = _InlineCode()
        finder.feed(bad)
        assert finder.found, bad
    finder = _InlineCode()
    finder.feed('<script src="app.js" defer></script><a href="#" data-on="x">on</a>')
    assert not finder.found


def test_every_service_in_the_config_is_allowed_by_the_policy():
    config = (WEB / "config.js").read_text(encoding="utf-8")
    allowed = _csp()["connect-src"]
    fetched = [line for line in config.splitlines() if "repoUrl" not in line]  # a link, never fetched
    for url in re.findall(r'"(https://[^"/]+)', "\n".join(fetched)):
        assert url in allowed, f"{url} is used in config.js but blocked by web/_headers"


def test_policy_blocks_framing_plugins_and_foreign_forms():
    csp = _csp()
    assert csp["frame-ancestors"] == ["'none'"]
    assert csp["object-src"] == ["'none'"]
    assert csp["form-action"] == ["'self'"]
    headers = (WEB / "_headers").read_text(encoding="utf-8")
    for name in ("X-Content-Type-Options: nosniff", "Referrer-Policy", "Strict-Transport-Security"):
        assert name in headers


def test_test_overrides_only_work_on_a_local_copy():
    kit = (WEB / "kit.js").read_text(encoding="utf-8")
    assert 'const params = LOCAL ? new URLSearchParams(window.location.search) : new URLSearchParams();' in kit
    assert kit.count("window.location.search") == 1
    for page_script in ("app.js", "solar.js"):   # both pages read the overrides only through kit.js
        js = (WEB / page_script).read_text(encoding="utf-8")
        assert "params.get(" not in js and "kit.dataUrl(cfg)" in js and "kit.basemapOverride()" in js, page_script


# National Grid's REST API terms require this exact text on any map that shows its hosting
# capacity layers, so the test holds it word for word and fails if anyone edits it.
NATIONAL_GRID_DISCLAIMER = (
    "The maps and Hosting Capacity information provided by National Grid and contained herein are for "
    "general informational purposes only and are subject to change without notice. Nothing herein shall be "
    "construed as conferring any intellectual property or other proprietary rights to you in any content "
    "contained herein or otherwise. The content contained herein is provided on an \"as is\" and "
    "\"as available\" basis without warranty, representation, endorsement, or guarantee. By using the "
    "National Grid NY Hosting Capacity REST service URL you assume all risks regarding availability, quality, "
    "condition, completeness, accuracy, reliability, and use related to the maps, information, and any data "
    "derived therefrom."
)


CENTRAL_HUDSON_NOTICE = (
    "This data is being provided for informational purposes only and is not intended to be a "
    "substitute for the established interconnection application process."
)


def _notice(html: str, source_id: str) -> str:
    block = re.search(rf'id="source-{source_id}".*?<blockquote class="disclaimer">(.*?)</blockquote>', html, re.S)
    assert block, f"the disclaimer for {source_id} is missing from terms.html"
    return " ".join(block.group(1).split())


# The limitation NYSERDA publishes with its list of connected solar (data.ny.gov, wgsj-jt5f).
NYSERDA_LIMITATION = (
    "This dataset is a derivative product of publicly available information and as such NYSERDA does not "
    "vouch for the precision of the data from the public sources."
)


def test_each_utility_disclaimer_is_on_the_terms_page_word_for_word():
    html = (WEB / "terms.html").read_text(encoding="utf-8")
    assert _notice(html, "national_grid_ny_pv") == NATIONAL_GRID_DISCLAIMER
    assert _notice(html, "central_hudson_ny_pv") == CENTRAL_HUDSON_NOTICE
    assert _notice(html, "nyserda") == NYSERDA_LIMITATION


def test_the_solar_page_credits_nyserda_and_links_to_its_note():
    html = (WEB / "solar.html").read_text(encoding="utf-8")
    js = (WEB / "solar.js").read_text(encoding="utf-8")
    assert 'href="terms.html#source-nyserda" target="_blank" rel="noopener"' in html   # panel footer
    assert js.count('href="terms.html#source-nyserda" target="_blank" rel="noopener"') == 2   # credits and every card
    assert 'href="https://data.ny.gov/d/wgsj-jt5f"' in js
    terms = (WEB / "terms.html").read_text(encoding="utf-8")
    assert "OPEN-NY Terms of Use" in terms and "US Census Bureau" in terms


def test_every_source_has_a_note_on_the_terms_page():
    """Every line's card links to terms.html#source-<source id>, so a new utility needs a note."""
    from capacity_atlas.sources import SOURCES

    html = (WEB / "terms.html").read_text(encoding="utf-8")
    missing = [s for s in SOURCES if f'id="source-{s}"' not in html]
    assert not missing, f"add a disclaimer note in terms.html for: {missing}"


def test_the_map_links_to_the_terms_page_from_its_credits_footer_and_cards():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    assert 'href="terms.html" target="_blank" rel="noopener"' in html   # panel footer and guide
    assert js.count('href="terms.html') == 2                               # credits and every card


def test_terms_page_does_not_link_to_national_grid():
    """National Grid's portal terms ask for written consent before anyone links to it."""
    html = (WEB / "terms.html").read_text(encoding="utf-8")
    assert "nationalgrid" not in " ".join(re.findall(r'href="([^"]+)"', html)).lower()


def test_both_pages_introduce_their_credits_through_the_shared_kit():
    """The credits glow and fold the same way on both pages, so the code lives once, in kit.js."""
    kit = (WEB / "kit.js").read_text(encoding="utf-8")
    assert "function introduceCredits(" in kit and "credits-folding" in kit
    for script in ("app.js", "solar.js"):
        js = (WEB / script).read_text(encoding="utf-8")
        assert "kit.introduceCredits(map" in js, script
        assert "credits-folding" not in js and "CREDITS_OPEN_MS" not in js, f"{script} has its own copy"


def test_both_pages_have_a_guide():
    for page in ("index.html", "solar.html"):
        html = (WEB / page).read_text(encoding="utf-8")
        assert 'id="help-toggle"' in html and 'id="help"' in html and '<ol class="steps">' in html, page


def test_the_credits_fold_cannot_leave_the_box_squeezed():
    """A background tab runs the fold's timer before its animation frame. The frame must check that
    the fold is still going, the end must cancel it, and opening the box must clear what is left."""
    kit = (WEB / "kit.js").read_text(encoding="utf-8")
    fold = kit[kit.index("function introduceCredits("):kit.index("// ---------- folding the side panel")]
    assert "cancelAnimationFrame(frame)" in fold and "if (!closing) return;" in fold
    assert 'box.addEventListener("toggle"' in fold and "settle();" in fold


def _contrast(fg: str, bg: str) -> float:
    def lum(hex_color: str) -> float:
        r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
        lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    hi, lo = sorted((lum(fg), lum(bg)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def test_small_text_colors_meet_wcag_aa_on_both_themes():
    css = (WEB / "style.css").read_text(encoding="utf-8")
    dark = css[css.index(":root {"):css.index(":root[data-theme=\"light\"]")]
    light = css[css.index(":root[data-theme=\"light\"]"):]
    def var(block: str, name: str) -> str:
        return re.search(rf"--{name}:\s*(#[0-9a-fA-F]{{6}})", block).group(1)
    for block in (dark, light):
        for text in ("muted", "faint", "accent-text"):
            for ground in ("ground", "raised"):
                ratio = _contrast(var(block, text), var(block, ground))
                assert ratio >= 4.5, f"--{text} on --{ground}: {ratio:.2f}"
