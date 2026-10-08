"""Static checks for the web map: every referenced file exists and the colors stay in sync."""

import re
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"


def test_every_local_file_referenced_by_the_page_exists():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    refs = re.findall(r'(?:src|href)="([^"#:]+)"', html)
    assert refs, "no local references found"
    missing = [r for r in refs if not (WEB / r).exists()]
    assert not missing, f"missing files: {missing}"


def test_every_font_in_the_stylesheet_exists():
    css = (WEB / "style.css").read_text(encoding="utf-8")
    fonts = re.findall(r'url\("([^"]+\.woff2)"\)', css)
    assert len(fonts) == 7
    assert all((WEB / f).exists() for f in fonts)


def test_map_colors_match_the_legend_colors():
    css = (WEB / "style.css").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    css_colors = dict(re.findall(r"--(c\d|none):\s*(#[0-9a-fA-F]{6})", css))
    js_block = re.search(r"const COLORS = \{([^}]*)\}", js).group(1)
    js_colors = dict(re.findall(r'(c\d|none): "(#[0-9a-fA-F]{6})"', js_block))
    assert css_colors and css_colors == js_colors


def test_site_text_follows_the_copy_rules():
    for name in ("index.html", "app.js"):
        assert "—" not in (WEB / name).read_text(encoding="utf-8"), f"em dash in {name}"


def test_data_url_has_no_trailing_slash():
    config = (WEB / "config.js").read_text(encoding="utf-8")
    url = re.search(r'dataUrl:\s*"([^"]+)"', config).group(1)
    assert url.startswith("https://") and not url.endswith("/")
