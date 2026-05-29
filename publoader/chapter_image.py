"""Render a per-chapter info card image used as the visible page on
MangaDex when the publisher takes the chapter down. Generated on demand by
the unavailable worker (workers/unavailable.py) at the moment a chapter is
marked unavailable, then uploaded straight to the chapter as its page.

The layout reproduces the "MangaDex Chapter Card" design handoff: a clean
white 1:1 card with subtle coral-orange (#FF6740) accents — an orange hairline
and "External Chapter" eyebrow up top, a publisher pill, the series title with
an accent bar, the chapter number/title, the source URL in a soft pill, and a
footer with the language, availability window and a removed-from-publisher
note. A faint ghost chapter number sits behind the top-right corner.

Fonts (Space Grotesk, DM Sans, JetBrains Mono) are vendored under
assets/fonts/ so the render is identical regardless of host fonts.
"""

from __future__ import annotations

import datetime
import re
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import List, Optional

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - dependency guard
    Image = None  # type: ignore[assignment]
    ImageDraw = None  # type: ignore[assignment]
    ImageFont = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


# Logical canvas is 1000x1000 (matching the design); we render at 2x so the
# exported PNG is a crisp 2000x2000, the resolution the design exports at.
_LOGICAL = 1000
_SCALE = 2

_FONT_DIR = Path(__file__).resolve().parent / "assets" / "fonts"
_FONT_FILES = {
    "grotesk": "SpaceGrotesk.ttf",
    "dm": "DMSans.ttf",
    "mono": "JetBrainsMono.ttf",
}

# ---- palette (from the design's CSS custom properties) ----
_ORANGE = (255, 103, 64)
_ORANGE_SOFT = (255, 241, 236)
_INK = (23, 23, 27)
_INK_SOFT = (91, 91, 99)
_INK_FAINT = (154, 154, 162)
_LINE = (236, 236, 239)
_GHOST = (246, 246, 248)
_PAPER = (255, 255, 255)

# A small ISO-639-1 map so footer reads "English" rather than "en"; unknown
# codes fall back to the raw value.
_LANG_NAMES = {
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "zh-hk": "Chinese (Traditional)",
    "es": "Spanish",
    "es-la": "Spanish (LATAM)",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
    "pt-br": "Portuguese (Brazil)",
    "ru": "Russian",
    "it": "Italian",
    "id": "Indonesian",
    "vi": "Vietnamese",
    "th": "Thai",
    "ar": "Arabic",
    "pl": "Polish",
    "tr": "Turkish",
    "uk": "Ukrainian",
}


def _px(v: float) -> int:
    return int(round(v * _SCALE))


@lru_cache(maxsize=64)
def _font(family: str, size: int, weight: int = 400, opsz: Optional[int] = None):
    """Load a vendored variable font at a given weight/optical size.

    Falls back to Pillow's default bitmap font if the file or FreeType support
    is missing, so card generation never hard-fails on a font issue."""
    if ImageFont is None:
        return None

    path = _FONT_DIR / _FONT_FILES.get(family, "")
    try:
        font = ImageFont.truetype(str(path), _px(size))
    except (OSError, IOError):
        return ImageFont.load_default()

    try:
        axes = font.get_variation_axes() or []
        values = []
        for axis in axes:
            name = axis.get("name", b"")
            name = name.decode() if isinstance(name, bytes) else name
            lo, hi = axis.get("minimum", 0), axis.get("maximum", 1000)
            if "Weight" in name:
                values.append(max(lo, min(hi, weight)))
            elif "Optical" in name:
                target = opsz if opsz is not None else size
                values.append(max(lo, min(hi, target)))
            else:
                values.append(axis.get("default", lo))
        if values:
            font.set_variation_by_axes(values)
    except Exception:  # pragma: no cover - variation unsupported / static font
        pass
    return font


def _wrap_words(draw, text: str, font, max_w: int, max_lines: int) -> List[str]:
    """Greedy word-wrap to a pixel width, truncating with an ellipsis only if
    the text genuinely overflows the allotted lines."""
    words = (text or "").split()
    lines: List[str] = []
    cur = ""
    i = 0
    while i < len(words):
        word = words[i]
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
            i += 1
        else:
            lines.append(cur)
            cur = ""
            if len(lines) == max_lines:
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
        i = len(words)

    if i < len(words) and lines:  # ran out of lines before words → clipped
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > max_w:
            last = last[:-1]
        lines[-1] = (last + "…") if last else "…"
    return lines or [""]


def _wrap_chars(draw, text: str, font, max_w: int, max_lines: int = 3) -> List[str]:
    """Character-level wrap (for URLs, mirroring CSS word-break: break-all)."""
    lines: List[str] = []
    cur = ""
    for ch in text or "":
        if draw.textlength(cur + ch, font=font) <= max_w or not cur:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
            if len(lines) == max_lines - 1:
                break
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        tail = lines[-1]
        while tail and draw.textlength(tail + "…", font=font) > max_w:
            tail = tail[:-1]
        lines[-1] = tail + "…"
    return lines or [""]


def _tracked_width(draw, text: str, font, tracking: float) -> float:
    if not text:
        return 0.0
    return sum(draw.textlength(c, font=font) for c in text) + tracking * (len(text) - 1)


def _draw_tracked(draw, x, y, text, font, fill, tracking, anchor="la"):
    """Draw letter-spaced text (Pillow has no native letter-spacing).

    Horizontal anchor l/m/r; vertical anchor passed through per glyph."""
    halign = anchor[0]
    valign = anchor[1] if len(anchor) > 1 else "a"
    if halign in ("m", "r"):
        w = _tracked_width(draw, text, font, tracking)
        x -= w / 2 if halign == "m" else w
    cx = x
    for ch in text:
        draw.text((cx, y), ch, font=font, fill=fill, anchor="l" + valign)
        cx += draw.textlength(ch, font=font) + tracking
    return cx


def _fmt_date(value) -> Optional[str]:
    """Format a date for the footer; drop the 1990 'unknown' sentinel."""
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    if isinstance(value, datetime.datetime):
        if value.year <= 1990:
            return None
        return value.strftime("%d %b %Y")
    return str(value)


def generate_chapter_card(
    *,
    manga_name: Optional[str] = None,
    chapter_number: Optional[str] = None,
    chapter_title: Optional[str] = None,
    chapter_language: Optional[str] = None,
    extension_name: Optional[str] = None,
    chapter_url: Optional[str] = None,
    publisher: Optional[str] = None,
    available_from=None,
    available_to=None,
    footer_note: Optional[str] = None,
) -> bytes:
    """Return PNG bytes for the chapter info card."""
    if Image is None:
        raise RuntimeError(
            f"Pillow is not installed; cannot generate chapter cards: {_IMPORT_ERROR}"
        )

    W = H = _px(_LOGICAL)
    img = Image.new("RGB", (W, H), color=_PAPER)
    draw = ImageDraw.Draw(img)

    pad_l, pad_r, pad_t, pad_b = _px(88), _px(88), _px(92), _px(78)
    content_l = pad_l
    content_r = W - pad_r
    content_w = content_r - content_l

    # ---- ghost chapter number (behind everything, top-right) ----
    digits = None
    if chapter_number:
        m = re.search(r"\d+(?:\.\d+)?", str(chapter_number))
        digits = m.group(0) if m else None
    if digits:
        ghost_font = _font("grotesk", 300, weight=700)
        draw.text(
            (W + _px(34), _px(8)),
            digits,
            font=ghost_font,
            fill=_GHOST,
            anchor="ra",
        )

    # ---- orange hairline at the very top ----
    draw.rectangle([0, 0, W, _px(8)], fill=_ORANGE)

    # ---- header: eyebrow (left) + publisher pill (right) ----
    eyebrow_font = _font("grotesk", 19, weight=600)
    eyebrow_track = 0.22 * _px(19)
    dot_d = _px(13)
    text_x = content_l + dot_d + _px(14)
    # single line, dot vertically centred against it
    block_mid = pad_t + _px(13)
    _draw_tracked(
        draw,
        text_x,
        block_mid,
        "EXTERNAL CHAPTER",
        eyebrow_font,
        _INK,
        eyebrow_track,
        anchor="lm",
    )
    draw.ellipse(
        [content_l, block_mid - dot_d / 2, content_l + dot_d, block_mid + dot_d / 2],
        fill=_ORANGE,
    )

    pub_value = (publisher or extension_name or "Unknown").strip()
    pub_label_font = _font("grotesk", 12, weight=600)
    pub_value_font = _font("dm", 19, weight=600)
    pub_label_track = 0.18 * _px(12)
    # Truncate an over-long publisher so the pill keeps its shape.
    while pub_value and draw.textlength(pub_value, font=pub_value_font) > _px(240):
        pub_value = pub_value[:-1]
    label_w = _tracked_width(draw, "PUBLISHER", pub_label_font, pub_label_track)
    value_w = draw.textlength(pub_value, font=pub_value_font)
    gap = _px(11)
    pad_x, pad_y = _px(22), _px(11)
    inner_w = label_w + gap + value_w
    pill_w = inner_w + pad_x * 2
    pill_h = _px(19) + pad_y * 2
    pill_x1 = content_r
    pill_x0 = pill_x1 - pill_w
    pill_y0 = block_mid - pill_h / 2
    pill_y1 = pill_y0 + pill_h
    draw.rounded_rectangle(
        [pill_x0, pill_y0, pill_x1, pill_y1],
        radius=pill_h / 2,
        outline=_LINE,
        width=max(1, _px(1.5)),
    )
    pill_mid = (pill_y0 + pill_y1) / 2
    lx = _draw_tracked(
        draw,
        pill_x0 + pad_x,
        pill_mid,
        "PUBLISHER",
        pub_label_font,
        _INK_FAINT,
        pub_label_track,
        anchor="lm",
    )
    draw.text(
        (lx + gap, pill_mid), pub_value, font=pub_value_font, fill=_INK, anchor="lm"
    )

    header_bottom = pill_y1

    # ---- footer layout, computed up-front so the body can be vertically
    # centred between the header and the footer (mirroring the design's flex
    # column: header top, body flex:1 centred, footer bottom) ----
    k_font = _font("grotesk", 14, weight=600)
    val_font = _font("dm", 21, weight=600)
    note_font = _font("dm", 18, weight=400)
    arrow_font = _font("dm", 21, weight=700)
    k_track = 0.16 * _px(14)

    lang_display = None
    if chapter_language:
        lang_display = _LANG_NAMES.get(str(chapter_language).lower(), chapter_language)

    date_from = _fmt_date(available_from)
    date_to = _fmt_date(available_to)
    # Only show the availability window when we know when it started — a lone
    # removal date under an "Available" label reads as misinformation.
    show_window = bool(date_from)

    if footer_note:
        note_text = footer_note
    elif show_window:
        note_text = (
            "This chapter was officially available on the publisher's site "
            "during the dates above. It has since been removed and is no longer "
            "accessible there."
        )
    else:
        note_text = (
            "This chapter was officially available on the publisher's site. "
            "It has since been removed and is no longer accessible there."
        )
    note_lines = _wrap_words(draw, note_text, note_font, _px(760), max_lines=4)

    row_h = _px(28)
    gap_v = _px(14)
    note_adv = _px(18 * 1.45)
    rows = []  # ("language"|"available")
    if lang_display:
        rows.append("language")
    if show_window:
        rows.append("available")

    footer_h = _px(30)
    for _ in rows:
        footer_h += row_h + gap_v
    footer_h += note_adv * len(note_lines)
    foot_top = (H - pad_b) - footer_h

    # ---- body: pre-wrap everything and measure, then centre in the gap ----
    series_font = _font("grotesk", 17, weight=700)
    title_font = _font("grotesk", 78, weight=700)
    chnum_font = _font("grotesk", 22, weight=600)
    chtitle_font = _font("grotesk", 44, weight=700)
    url_label_font = _font("grotesk", 15, weight=600)
    url_font = _font("mono", 21, weight=500)

    title_x = content_l + _px(6) + _px(30)
    title_lines = _wrap_words(
        draw, manga_name or "Untitled", title_font, content_r - title_x, max_lines=2
    )
    title_adv = _px(78 * 1.02)

    chnum_text = str(chapter_number or "").strip()
    if chnum_text and not chnum_text.lower().startswith("chapter"):
        chnum_text = f"Chapter {chnum_text}"
    elif not chnum_text:
        chnum_text = "Chapter"

    chtitle_lines = (
        _wrap_words(draw, chapter_title, chtitle_font, content_w, max_lines=2)
        if chapter_title
        else []
    )
    chtitle_adv = _px(44 * 1.08)

    upad_x, upad_y = _px(22), _px(14)
    url_adv = _px(21 * 1.3)
    url_lines: List[str] = []
    url_pill_h = 0
    if chapter_url:
        url_lines = _wrap_chars(
            draw, chapter_url, url_font, content_w - upad_x * 2, max_lines=3
        )
        url_pill_h = len(url_lines) * url_adv + upad_y * 2

    series_block = _px(17 * 1.2) + _px(22)
    title_block = len(title_lines) * title_adv
    divider_block = _px(52) + _px(46)
    chnum_block = _px(22 * 1.2) + _px(13)
    chtitle_block = len(chtitle_lines) * chtitle_adv
    url_block = (_px(40) + _px(15 * 1.2) + _px(12) + url_pill_h) if chapter_url else 0
    body_h = (
        series_block
        + title_block
        + divider_block
        + chnum_block
        + chtitle_block
        + url_block
    )

    # Centre the body in the gap, but never crowd the header.
    y = header_bottom + max(_px(24), (foot_top - header_bottom - body_h) / 2)

    # SERIES label
    _draw_tracked(draw, content_l, y, "SERIES", series_font, _INK_FAINT, 0.26 * _px(17))
    y += series_block

    # manga title with accent bar
    title_top = y
    for i, line in enumerate(title_lines):
        draw.text(
            (title_x, title_top + i * title_adv), line, font=title_font, fill=_INK
        )
    # Accent bar spans the full visible title: cap-top of the first line down to
    # the baseline of the last. Text is drawn anchor "la" (ascender at title_top),
    # so the baseline sits ascent below it; cap-height is ~0.7em for Space Grotesk.
    t_ascent, _ = title_font.getmetrics()
    cap_h = _px(78 * 0.70)
    draw.rounded_rectangle(
        [
            content_l,
            title_top + t_ascent - cap_h,
            content_l + _px(6),
            title_top + (len(title_lines) - 1) * title_adv + t_ascent,
        ],
        radius=_px(3),
        fill=_ORANGE,
    )
    y = title_top + title_block

    # divider
    y += _px(52)
    draw.rectangle([content_l, y, content_r, y + max(1, _px(1.5))], fill=_LINE)
    y += _px(46)

    # chapter number + title
    _draw_tracked(
        draw, content_l, y, chnum_text.upper(), chnum_font, _ORANGE, 0.14 * _px(22)
    )
    y += chnum_block

    if chtitle_lines:
        for i, line in enumerate(chtitle_lines):
            draw.text(
                (content_l, y + i * chtitle_adv), line, font=chtitle_font, fill=_INK
            )
        y += chtitle_block

    # source URL
    if chapter_url:
        y += _px(40)
        _draw_tracked(
            draw, content_l, y, "SOURCE", url_label_font, _INK_FAINT, 0.18 * _px(15)
        )
        y += _px(15 * 1.2) + _px(12)

        url_text_w = max(draw.textlength(l, font=url_font) for l in url_lines)
        pill_w = min(content_w, url_text_w + upad_x * 2)
        draw.rounded_rectangle(
            [content_l, y, content_l + pill_w, y + url_pill_h],
            radius=_px(10),
            fill=_ORANGE_SOFT,
        )
        for i, line in enumerate(url_lines):
            draw.text(
                (content_l + upad_x, y + upad_y + i * url_adv),
                line,
                font=url_font,
                fill=_INK,
            )

    # ---- footer ----
    draw.rectangle(
        [content_l, foot_top, content_r, foot_top + max(1, _px(1.5))], fill=_LINE
    )
    yy = foot_top + _px(30)

    for row in rows:
        mid = yy + row_h / 2
        kx = _draw_tracked(
            draw,
            content_l,
            mid,
            row.upper(),
            k_font,
            _INK_FAINT,
            k_track,
            anchor="lm",
        )
        vx = kx + _px(16)
        if row == "language":
            draw.text((vx, mid), lang_display, font=val_font, fill=_INK, anchor="lm")
        else:
            if date_from:
                draw.text((vx, mid), date_from, font=val_font, fill=_INK, anchor="lm")
                vx += draw.textlength(date_from, font=val_font) + _px(16)
                draw.text((vx, mid), "→", font=arrow_font, fill=_ORANGE, anchor="lm")
                vx += draw.textlength("→", font=arrow_font) + _px(16)
            draw.text(
                (vx, mid),
                date_to or "now",
                font=val_font,
                fill=_INK,
                anchor="lm",
            )
        yy += row_h + gap_v

    for i, line in enumerate(note_lines):
        draw.text((content_l, yy + i * note_adv), line, font=note_font, fill=_INK_SOFT)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
