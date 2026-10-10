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
    for name in ("index.html", "app.js"):
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
    html = (WEB / "index.html").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    ids = set(re.findall(r'\$\("([a-z][a-z0-9-]*)"\)', js))
    created_by_script = {"zoom-feeder", "copy-link"}  # built inside the detail card at runtime
    missing = sorted(i for i in ids - created_by_script if f'id="{i}"' not in html)
    assert not missing, f"ids used in app.js but missing from index.html: {missing}"
