from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional
from urllib.parse import urlsplit

from . import snapshot
from .snapshot import SnapshotError

INDEX_SCHEMA = "balligh.library.fatwa.index/2"
RECORD_SCHEMA = "balligh.library.fatwa/2"
PUBLISHER = "binbaz.org.sa"
PUBLISHER_NAME = "موقع الشيخ ابن باز"
REUSE_BASIS = "user_confirmed_permission"
REVIEW_STATUS = "source_preserved"
TOPICS = ("understanding_islam", "belief", "worship", "conduct")
KINDS = ("text", "strong", "quran", "hadith", "noteref")
NOTE_KINDS = ("text", "strong", "quran", "hadith")
PRIORITY = {"text": 0, "strong": 1, "hadith": 2, "quran": 3, "noteref": 4}
NOTE_ID = re.compile(r"^[1-9][0-9]{0,3}$")
NOTE_HREF = re.compile(r"^#footnote-([1-9][0-9]{0,3})$")
NOTE_LI_ID = re.compile(r"^footnote-([1-9][0-9]{0,3})$")
MARKER_TEXT = re.compile(r"\[[1-9][0-9]{0,3}\]")
QUESTION_LABEL = "السؤال"
ANSWER_LABEL = "الجواب"
ID_PATTERN = re.compile(r"^binbaz-([1-9][0-9]{0,9})$")
SHA_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
FATWA_PATH = re.compile(r"^/fatwas/([1-9][0-9]{0,9})(?:/[^/?#]+)?$")
CATEGORY_URL = re.compile(r"^https://binbaz\.org\.sa/categories/(objective|fiqhi)/([1-9][0-9]{0,5})$")
RECORD_KEYS = frozenset({
    "schema", "id", "source_record_id", "type", "language", "title", "question", "answer", "notes", "topic",
    "source_categories", "source", "reuse_basis", "review_status", "translations", "raw_sha256", "content_sha256",
})
SOURCE_KEYS = frozenset({"publisher", "publisher_name", "url", "retrieved_at", "edition", "series"})
ENTRY_KEYS = frozenset({"id", "title", "topic", "source_url", "file", "sha256", "content_sha256", "audience_reason"})

BLOCK_TAGS = frozenset(
    "address article aside blockquote caption dd details div dl dt fieldset figcaption figure footer form "
    "h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul".split()
)
DROP_TAGS = frozenset(
    "applet area audio button canvas embed frame frameset head iframe img input link map math meta noscript "
    "object picture select source style script svg template textarea title track video".split()
)
VOID_TAGS = frozenset("area base br col embed hr img input link meta param source track wbr".split())
ASCII_WS = " \t\n\r\f"
SOURCE_WS = re.compile(r"[ \t\n\r\f]*[\t\n\r\f][ \t\n\r\f]*")
TOKEN = re.compile(
    r"<!--.*?-->|<(script|style)\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>.*?</\1\s*>"
    r"|<(/?)([A-Za-z][A-Za-z0-9]*)\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>",
    re.S | re.I,
)
ATTR = re.compile(r"""([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?""")
RAW_COMMENT = re.compile(r"<!--.*?-->", re.S)
RAW_DROP = re.compile(
    r"<(%s)\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>.*?</\1\s*>" % "|".join(sorted(DROP_TAGS - VOID_TAGS)),
    re.S | re.I,
)
RAW_TAG = re.compile(r"</?([A-Za-z][A-Za-z0-9]*)\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>")
RAW_SPAN_TAG = re.compile(r"<(/?)span\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>", re.I)
RAW_BR = re.compile(r"<br\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", re.I)
EDITION = re.compile(r"\((مجموع فتاوى[^()]*)\)")


class _Runs(HTMLParser):
    def __init__(self, note_ids: frozenset[str] = frozenset()) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, Optional[str], int, bool]] = []
        self.pieces: list[tuple[str, int, str, bool]] = []
        self.paragraphs: list[list[dict[str, str]]] = []
        self.serial = 0
        self.note_ids = note_ids
        self.note_of: dict[int, str] = {}

    def _dropping(self) -> bool:
        return any(entry[3] for entry in self.stack)

    def _kind(self) -> tuple[str, int]:
        kind, serial = "text", 0
        for _, k, s, _ in self.stack:
            if k and PRIORITY[k] > PRIORITY[kind]:
                kind, serial = k, s
        return kind, serial

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        if tag in VOID_TAGS:
            if self._dropping():
                return
            if tag == "br":
                kind, serial = self._kind()
                self.pieces.append((kind, serial, "\n", True))
            elif tag == "hr":
                self.flush()
            return
        if self._dropping() or tag in DROP_TAGS:
            self.stack.append((tag, None, 0, True))
            return
        if tag in BLOCK_TAGS:
            self.flush()
            self.stack.append((tag, None, 0, False))
            return
        classes = " ".join(v or "" for k, v in attrs if k.lower() == "class").split()
        kind = "quran" if "aaya" in classes else "hadith" if "hadith" in classes else "strong" if tag in ("strong", "b") else None
        note = _marker_note(tag, attrs)
        if note is not None and note in self.note_ids:
            kind = "noteref"
        serial = 0
        if kind:
            self.serial += 1
            serial = self.serial
            if kind == "noteref":
                self.note_of[serial] = note
        self.stack.append((tag, kind, serial, False))

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in VOID_TAGS:
            return
        dropping = self._dropping()
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break
        if tag in BLOCK_TAGS and not dropping:
            self.flush()

    def handle_data(self, data: str) -> None:
        if data and not self._dropping():
            kind, serial = self._kind()
            self.pieces.append((kind, serial, data, False))

    def flush(self) -> None:
        pieces = [[k, s, t if br else SOURCE_WS.sub(" ", t)] for k, s, t, br in self.pieces]
        self.pieces = []
        while pieces and not pieces[0][2].strip(ASCII_WS):
            pieces.pop(0)
        while pieces and not pieces[-1][2].strip(ASCII_WS):
            pieces.pop()
        if not pieces:
            return
        pieces[0][2] = pieces[0][2].lstrip(ASCII_WS)
        pieces[-1][2] = pieces[-1][2].rstrip(ASCII_WS)
        runs: list[list[Any]] = []
        for kind, serial, text in pieces:
            if not text:
                continue
            key = (kind, serial if kind in ("quran", "hadith", "noteref") else 0)
            if runs and runs[-1][0] == key:
                runs[-1][1] += text
            else:
                runs.append([key, text])
        paragraph = [
            {"kind": key[0], "text": text, "note": self.note_of[key[1]]} if key[0] == "noteref" else {"kind": key[0], "text": text}
            for key, text in runs
        ]
        if "".join(r["text"] for r in paragraph).strip():
            self.paragraphs.append(paragraph)


def _marker_note(tag: str, attrs: list[tuple[str, Optional[str]]]) -> Optional[str]:
    if tag != "a":
        return None
    found: dict[str, str] = {}
    for k, v in attrs:
        found.setdefault(k.lower(), v or "")
    m = NOTE_HREF.match(found.get("href", ""))
    if not m or "footnote" not in found.get("rel", "").split():
        return None
    return m.group(1)


def parse_runs(fragment: str, note_ids: frozenset[str] = frozenset()) -> list[list[dict[str, str]]]:
    parser = _Runs(frozenset(note_ids))
    parser.feed(fragment)
    parser.close()
    parser.flush()
    return parser.paragraphs


def _collapse(text: str) -> str:
    return " ".join(text.split())


def paragraph_text(paragraph: list[dict[str, str]]) -> str:
    return "".join(run["text"] for run in paragraph)


def plain_text(paragraphs: list[list[dict[str, str]]]) -> str:
    return "\n".join(paragraph_text(p) for p in paragraphs)


def raw_segments(fragment: str) -> list[str]:
    text = RAW_DROP.sub("", RAW_COMMENT.sub("", fragment))
    segments: list[str] = []
    buf: list[str] = []
    pos = 0
    for m in RAW_TAG.finditer(text):
        buf.append(text[pos:m.start()])
        pos = m.end()
        name = m.group(1).lower()
        if name == "br":
            buf.append(" ")
        elif name in BLOCK_TAGS:
            segments.append("".join(buf))
            buf = []
    buf.append(text[pos:])
    segments.append("".join(buf))
    return [s for s in (_collapse(html.unescape(seg)) for seg in segments) if s]


def raw_marked(fragment: str, cls: str) -> list[str]:
    text = RAW_DROP.sub("", RAW_COMMENT.sub("", fragment))
    found = []
    depth: list[bool] = []
    start: Optional[tuple[int, int]] = None
    for m in RAW_SPAN_TAG.finditer(text):
        if not m.group(1):
            if m.group(2).rstrip().endswith("/"):
                continue
            target = cls in _attrs(m.group(2)).get("class", "").split()
            if target and start is None:
                start = (m.end(), len(depth))
            depth.append(target)
        elif depth:
            depth.pop()
            if start is not None and len(depth) == start[1]:
                inner = RAW_TAG.sub("", RAW_BR.sub(" ", text[start[0]:m.start()]))
                start = None
                if _collapse(html.unescape(inner)):
                    found.append(_collapse(html.unescape(inner)))
    return found


def marked_runs(paragraphs: list[list[dict[str, str]]], kind: str) -> list[str]:
    return [_collapse(r["text"]) for p in paragraphs for r in p if r["kind"] == kind and _collapse(r["text"])]


def _attrs(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in ATTR.finditer(raw or ""):
        name = m.group(1).lower()
        if name not in out:
            value = m.group(2) if m.group(2) is not None else m.group(3) if m.group(3) is not None else m.group(4) or ""
            out[name] = html.unescape(value)
    return out


def _open_tags(doc: str, start: int, stop: int) -> Iterator[re.Match[str]]:
    for m in TOKEN.finditer(doc, start, stop):
        if m.group(3) and not m.group(2):
            yield m


def _close(doc: str, opening: re.Match[str], stop: int) -> tuple[int, int]:
    name = opening.group(3).lower()
    depth = 1
    for m in TOKEN.finditer(doc, opening.end(), stop):
        if not m.group(3) or m.group(3).lower() != name:
            continue
        if m.group(2):
            depth -= 1
        elif not m.group(4).rstrip().endswith("/"):
            depth += 1
        if depth == 0:
            return m.start(), m.end()
    raise SnapshotError(f"unclosed <{name}> element")


def _first(doc: str, start: int, stop: int, name: str, cls: Optional[str] = None, **attrs: str) -> Optional[re.Match[str]]:
    for m in _open_tags(doc, start, stop):
        if m.group(3).lower() != name:
            continue
        found = _attrs(m.group(4))
        if cls is not None and cls not in found.get("class", "").split():
            continue
        if any(found.get(k) != v for k, v in attrs.items()):
            continue
        return m
    return None


def _inner(doc: str, opening: re.Match[str], stop: int) -> tuple[str, int]:
    close_start, close_end = _close(doc, opening, stop)
    return doc[opening.end():close_start], close_end


def locate_article(doc: str) -> tuple[int, int]:
    for m in _open_tags(doc, 0, len(doc)):
        if m.group(3).lower() == "article":
            classes = _attrs(m.group(4)).get("class", "").split()
            if "fatwa" in classes and "box__body__element" not in classes:
                return m.start(), _close(doc, m, len(doc))[1]
    raise SnapshotError("no fatwa article on the page")


def article_fragments(article_html: str) -> dict[str, Any]:
    opening = next(_open_tags(article_html, 0, len(article_html)), None)
    if opening is None or opening.group(3).lower() != "article":
        raise SnapshotError("the fragment is not an article")
    stop = _close(article_html, opening, len(article_html))[0]
    start = opening.end()
    h1 = _first(article_html, start, stop, "h1", "article-title")
    if h1 is None:
        raise SnapshotError("no title in the article")
    title_html, title_end = _inner(article_html, h1, stop)
    h2 = _first(article_html, title_end, stop, "h2", "article-title__question")
    if h2 is None:
        raise SnapshotError("no question block in the article")
    question_html, question_end = _inner(article_html, h2, stop)
    body = _first(article_html, question_end, stop, "div", None, itemprop="articleBody")
    if body is None:
        raise SnapshotError("no answer body in the article")
    answer_html, answer_end = _inner(article_html, body, stop)
    answer_html, notes, notes_leftover = split_notes(answer_html)
    between = article_html[question_end:body.start()]
    audio = _first(between, 0, len(between), "div", "audio")
    leftover = article_html[start:h1.start()] + article_html[title_end:h2.start()] + article_html[answer_end:stop]
    if audio is not None:
        audio_end = _close(between, audio, len(between))[1]
        leftover += between[:audio.start()] + between[audio_end:]
        audio_attrs = re.findall(r'https:\\?/\\?/files\.zadapps\.info[^"&]*?\.mp3', between[audio.start():audio_end])
    else:
        leftover += between
        audio_attrs = []
    return {
        "title": title_html,
        "question": question_html,
        "answer": answer_html,
        "notes": notes,
        "leftover": raw_segments(leftover) + raw_segments(notes_leftover),
        "audio": sorted({a.replace("\\/", "/") for a in audio_attrs}),
    }


def split_notes(answer_html: str) -> tuple[str, list[tuple[str, str]], str]:
    notes: list[tuple[str, str]] = []
    kept: list[str] = []
    leftover: list[str] = []
    pos = 0
    while True:
        section = _first(answer_html, pos, len(answer_html), "section", "footnotes")
        if section is None:
            break
        inner, section_end = _inner(answer_html, section, len(answer_html))
        kept.append(answer_html[pos:section.start()])
        at = 0
        for m in _open_tags(inner, 0, len(inner)):
            if m.start() < at or m.group(3).lower() != "li":
                continue
            hit = NOTE_LI_ID.match(_attrs(m.group(4)).get("id", ""))
            if not hit:
                raise SnapshotError("footnote list item without a source note number")
            note_html, note_end = _inner(inner, m, len(inner))
            leftover.append(inner[at:m.start()])
            notes.append((hit.group(1), note_html))
            at = note_end
        leftover.append(inner[at:])
        pos = section_end
    kept.append(answer_html[pos:])
    ids = [n for n, _ in notes]
    if len(ids) != len(set(ids)):
        raise SnapshotError("duplicate footnote numbers in the source list")
    return "".join(kept), notes, "<p>".join(leftover)


def raw_markers(fragment: str) -> list[tuple[str, str]]:
    text = RAW_DROP.sub("", RAW_COMMENT.sub("", fragment))
    found = []
    for m in _open_tags(text, 0, len(text)):
        if m.group(3).lower() != "a":
            continue
        attrs = _attrs(m.group(4))
        hit = NOTE_HREF.match(attrs.get("href", ""))
        if hit and "footnote" in attrs.get("rel", "").split():
            inner, _ = _inner(text, m, len(text))
            found.append((hit.group(1), _collapse(html.unescape(RAW_TAG.sub("", inner)))))
    return found


def parse_notes(notes: list[tuple[str, str]]) -> list[dict[str, Any]]:
    out = []
    for nid, note_html in notes:
        paragraphs = parse_runs(note_html)
        if len(paragraphs) != 1:
            raise SnapshotError(f"footnote {nid} has {len(paragraphs)} paragraphs; notes are kept one per source item and never merged")
        out.append({"id": nid, "runs": paragraphs[0]})
    return out


def note_text(note: Mapping[str, Any]) -> str:
    return "".join(run["text"] for run in note["runs"])


def unmatched_markers(record: Mapping[str, Any]) -> list[str]:
    return [m.group(0) for field in ("question", "answer") for p in record[field] for r in p if r["kind"] != "noteref" for m in MARKER_TEXT.finditer(r["text"])]


def parse_page(doc: str) -> dict[str, Any]:
    start, end = locate_article(doc)
    article_html = doc[start:end]
    parts = article_fragments(article_html)
    title_paragraphs = parse_runs(parts["title"])
    title = " ".join(paragraph_text(p) for p in title_paragraphs)
    notes = parse_notes(parts["notes"])
    note_ids = frozenset(n["id"] for n in notes)
    question = parse_runs(parts["question"], note_ids)
    answer = parse_runs(parts["answer"], note_ids)
    next_article = _first(doc, end, len(doc), "article")
    tail_stop = next_article.start() if next_article else len(doc)
    categories = []
    box = _first(doc, end, tail_stop, "div", "categories")
    if box is not None:
        box_html, _ = _inner(doc, box, tail_stop)
        for m in _open_tags(box_html, 0, len(box_html)):
            if m.group(3).lower() != "a":
                continue
            found = _attrs(m.group(4))
            if "categories__item" not in found.get("class", "").split():
                continue
            href = found.get("href", "")
            label_html, _ = _inner(box_html, m, len(box_html))
            label = " ".join(paragraph_text(p) for p in parse_runs(label_html))
            hit = CATEGORY_URL.match(href)
            if not hit or not label:
                raise SnapshotError(f"unexpected category link {href[:120]!r}")
            categories.append({"id": hit.group(2), "label": label, "url": href})
    series = None
    crumbs = _first(doc, 0, start, "ol", "breadcrumb")
    if crumbs is not None:
        crumbs_html, _ = _inner(doc, crumbs, start)
        for m in _open_tags(crumbs_html, 0, len(crumbs_html)):
            if m.group(3).lower() == "a" and re.match(r"^https://binbaz\.org\.sa/fatwas/kind/[0-9]+$", _attrs(m.group(4)).get("href", "")):
                label_html, _ = _inner(crumbs_html, m, len(crumbs_html))
                series = " ".join(paragraph_text(p) for p in parse_runs(label_html)) or None
                break
    canonical = None
    link = _first(doc, 0, start, "link", None, rel="canonical")
    if link is not None:
        canonical = _attrs(link.group(4)).get("href")
    editions = EDITION.findall("\n".join([plain_text(answer)] + [note_text(n) for n in notes]))
    return {
        "article_html": article_html,
        "title": title,
        "question": question,
        "answer": answer,
        "notes": notes,
        "categories": categories,
        "series": series,
        "edition": editions[-1] if editions else None,
        "canonical": canonical,
        "leftover": parts["leftover"],
        "audio": parts["audio"],
    }


def fatwa_id(url: str) -> Optional[str]:
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme != "https" or parts.netloc != PUBLISHER or parts.query or parts.fragment:
        return None
    m = FATWA_PATH.match(parts.path)
    return m.group(1) if m else None


def has_body(paragraphs: Any, label: str) -> bool:
    if not isinstance(paragraphs, list) or not paragraphs:
        return False
    text = _collapse(" ".join(paragraph_text(p) for p in paragraphs if isinstance(p, list)))
    if text.startswith(label):
        text = text[len(label):].lstrip(" :：")
    return bool(text.strip())


def build_record(parsed: Mapping[str, Any], url: str, retrieved_at: str, topic: str) -> dict[str, Any]:
    number = fatwa_id(url)
    if number is None:
        raise SnapshotError(f"not a binbaz fatwa url: {url[:200]!r}")
    if topic not in TOPICS:
        raise SnapshotError(f"unknown topic {topic!r}")
    record = {
        "schema": RECORD_SCHEMA,
        "id": f"binbaz-{number}",
        "source_record_id": number,
        "type": "fatwa",
        "language": "ar",
        "title": parsed["title"],
        "question": parsed["question"],
        "answer": parsed["answer"],
        "notes": parsed["notes"],
        "topic": topic,
        "source_categories": [dict(c) for c in parsed["categories"]],
        "source": {
            "publisher": PUBLISHER,
            "publisher_name": PUBLISHER_NAME,
            "url": url,
            "retrieved_at": retrieved_at,
            "edition": parsed["edition"],
            "series": parsed["series"],
        },
        "reuse_basis": REUSE_BASIS,
        "review_status": REVIEW_STATUS,
        "translations": {},
        "raw_sha256": snapshot.bytes_hash(parsed["article_html"].encode("utf-8")),
    }
    record["content_sha256"] = snapshot.content_hash(record)
    return record


def check_against_raw(record: Mapping[str, Any], article_html: str) -> None:
    rid = record.get("id")
    if snapshot.bytes_hash(article_html.encode("utf-8")) != record.get("raw_sha256"):
        raise SnapshotError(f"{rid}: raw_sha256 does not match the raw article")
    parts = article_fragments(article_html)
    if parts["leftover"]:
        raise SnapshotError(f"{rid}: article text outside title/question/answer: {parts['leftover'][:3]!r}")
    if _collapse(record["title"]) != " ".join(raw_segments(parts["title"])):
        raise SnapshotError(f"{rid}: title differs from the raw article")
    for field in ("question", "answer"):
        raw = raw_segments(parts[field])
        parsed = [_collapse(paragraph_text(p)) for p in record[field]]
        if len(raw) != len(parsed):
            raise SnapshotError(f"{rid}: {field} has {len(parsed)} paragraphs, the raw article has {len(raw)}")
        for i, (a, b) in enumerate(zip(parsed, raw)):
            if a != b:
                raise SnapshotError(f"{rid}: {field} paragraph {i + 1} differs from the raw article")
        for cls, kind in (("aaya", "quran"), ("hadith", "hadith")):
            if marked_runs(record[field], kind) != raw_marked(parts[field], cls):
                raise SnapshotError(f"{rid}: {field} {kind} runs differ from the raw span.{cls} elements")
    raw_ids = {nid for nid, _ in parts["notes"]}
    for field in ("question", "answer"):
        expected = [m for m in raw_markers(parts[field]) if m[0] in raw_ids]
        mine = [(r["note"], _collapse(r["text"])) for p in record[field] for r in p if r["kind"] == "noteref"]
        if expected != mine:
            raise SnapshotError(f"{rid}: {field} note references differ from the raw footnote markers")
    notes = record["notes"]
    if [n["id"] for n in notes] != [nid for nid, _ in parts["notes"]]:
        raise SnapshotError(f"{rid}: note ids or order differ from the raw footnote list")
    for note, (nid, note_html) in zip(notes, parts["notes"]):
        segments = raw_segments(note_html)
        if len(segments) != 1 or _collapse(note_text(note)) != segments[0]:
            raise SnapshotError(f"{rid}: note {nid} differs from the raw footnote item")
        for cls, kind in (("aaya", "quran"), ("hadith", "hadith")):
            if marked_runs([note["runs"]], kind) != raw_marked(note_html, cls):
                raise SnapshotError(f"{rid}: note {nid} {kind} runs differ from the raw span.{cls} elements")
    raw_question = raw_segments(parts["question"])
    if not raw_question or raw_question[0].startswith(QUESTION_LABEL) != paragraph_text(record["question"][0]).startswith(QUESTION_LABEL):
        raise SnapshotError(f"{rid}: question label differs from the raw article")


def _check_runs(rid: str, field: str, paragraph: Any, note_ids: frozenset[str], kinds: tuple[str, ...]) -> None:
    if not isinstance(paragraph, list) or not paragraph:
        raise SnapshotError(f"{rid}: {field} has an empty paragraph")
    for run in paragraph:
        if not isinstance(run, dict) or run.get("kind") not in kinds:
            raise SnapshotError(f"{rid}: {field} has a malformed run")
        if set(run) != ({"kind", "text", "note"} if run["kind"] == "noteref" else {"kind", "text"}):
            raise SnapshotError(f"{rid}: {field} has a malformed run")
        if not isinstance(run["text"], str) or not run["text"]:
            raise SnapshotError(f"{rid}: {field} has an invalid run")
        if run["kind"] == "noteref" and run["note"] not in note_ids:
            raise SnapshotError(f"{rid}: {field} references note {run['note']!r} that is not in notes")
    if not paragraph_text(paragraph).strip():
        raise SnapshotError(f"{rid}: {field} has a blank paragraph")


def _check_paragraphs(rid: str, field: str, value: Any, note_ids: frozenset[str] = frozenset()) -> None:
    if not isinstance(value, list) or not value:
        raise SnapshotError(f"{rid}: {field} is empty")
    for paragraph in value:
        _check_runs(rid, field, paragraph, note_ids, KINDS)


def _check_notes(rid: str, notes: Any) -> frozenset[str]:
    if not isinstance(notes, list):
        raise SnapshotError(f"{rid}: notes must be a list")
    ids: list[str] = []
    for note in notes:
        if not isinstance(note, dict) or set(note) != {"id", "runs"} or not isinstance(note["id"], str) or not NOTE_ID.match(note["id"]):
            raise SnapshotError(f"{rid}: malformed note")
        if note["id"] in ids:
            raise SnapshotError(f"{rid}: duplicate note id {note['id']}")
        ids.append(note["id"])
        _check_runs(rid, f"note {note['id']}", note["runs"], frozenset(), NOTE_KINDS)
    return frozenset(ids)


def validate_record(record: Any, expected_id: Optional[str] = None) -> dict[str, Any]:
    if not isinstance(record, dict) or set(record) != RECORD_KEYS:
        raise SnapshotError("record keys do not match the fatwa schema")
    rid = record["id"]
    m = ID_PATTERN.match(rid) if isinstance(rid, str) else None
    if not m or record["source_record_id"] != m.group(1) or (expected_id is not None and rid != expected_id):
        raise SnapshotError(f"bad record id {rid!r}")
    if record["schema"] != RECORD_SCHEMA or record["type"] != "fatwa" or record["language"] != "ar":
        raise SnapshotError(f"{rid}: wrong schema, type or language")
    if not isinstance(record["title"], str) or not record["title"].strip() or record["title"] != record["title"].strip(ASCII_WS):
        raise SnapshotError(f"{rid}: missing title")
    note_ids = _check_notes(rid, record["notes"])
    _check_paragraphs(rid, "question", record["question"], note_ids)
    _check_paragraphs(rid, "answer", record["answer"], note_ids)
    if not has_body(record["question"], QUESTION_LABEL):
        raise SnapshotError(f"{rid}: question has no text beyond its label")
    if not has_body(record["answer"], ANSWER_LABEL):
        raise SnapshotError(f"{rid}: answer has no text beyond its label")
    if record["topic"] not in TOPICS:
        raise SnapshotError(f"{rid}: topic {record['topic']!r} is not allowed")
    cats = record["source_categories"]
    if not isinstance(cats, list):
        raise SnapshotError(f"{rid}: source_categories must be a list")
    for cat in cats:
        if not isinstance(cat, dict) or set(cat) != {"id", "label", "url"}:
            raise SnapshotError(f"{rid}: malformed source category")
        hit = CATEGORY_URL.match(cat["url"]) if isinstance(cat["url"], str) else None
        if not hit or hit.group(2) != cat["id"] or not isinstance(cat["label"], str) or not cat["label"].strip():
            raise SnapshotError(f"{rid}: invalid source category")
    source = record["source"]
    if not isinstance(source, dict) or set(source) != SOURCE_KEYS:
        raise SnapshotError(f"{rid}: source keys do not match the schema")
    if source["publisher"] != PUBLISHER or not isinstance(source["publisher_name"], str) or not source["publisher_name"]:
        raise SnapshotError(f"{rid}: wrong publisher")
    if fatwa_id(source["url"]) != record["source_record_id"]:
        raise SnapshotError(f"{rid}: source url is not the https binbaz.org.sa page of this fatwa")
    if not isinstance(source["retrieved_at"], str) or not source["retrieved_at"]:
        raise SnapshotError(f"{rid}: missing retrieved_at")
    for key in ("edition", "series"):
        if source[key] is not None and (not isinstance(source[key], str) or not source[key].strip()):
            raise SnapshotError(f"{rid}: invalid source {key}")
    if record["reuse_basis"] != REUSE_BASIS or record["review_status"] != REVIEW_STATUS:
        raise SnapshotError(f"{rid}: wrong reuse basis or review status")
    if record["translations"] != {}:
        raise SnapshotError(f"{rid}: translations must be empty (Arabic-only source)")
    if not isinstance(record["raw_sha256"], str) or not SHA_PATTERN.match(record["raw_sha256"]):
        raise SnapshotError(f"{rid}: missing raw_sha256")
    body = {k: v for k, v in record.items() if k != "content_sha256"}
    if record["content_sha256"] != snapshot.content_hash(body):
        raise SnapshotError(f"{rid}: content_sha256 does not match the record content")
    return record


def build_files(
    records: list[Mapping[str, Any]],
    exclusions: list[Mapping[str, str]],
    selection: Mapping[str, Any],
    notices: list[str],
    reasons: Optional[Mapping[str, str]] = None,
) -> dict[str, bytes]:
    reasons = reasons or {}
    files: dict[str, bytes] = {}
    entries = []
    seen: set[str] = set()
    for record in records:
        validate_record(record)
        rid = record["id"]
        if rid in seen:
            raise SnapshotError(f"duplicate record id {rid}")
        seen.add(rid)
        rel = f"records/{rid}.json"
        data = snapshot.file_bytes(record)
        files[rel] = data
        entries.append({
            "id": rid,
            "title": record["title"],
            "topic": record["topic"],
            "source_url": record["source"]["url"],
            "file": rel,
            "sha256": snapshot.bytes_hash(data),
            "content_sha256": record["content_sha256"],
            "audience_reason": reasons.get(rid),
        })
    index = {
        "schema": INDEX_SCHEMA,
        "count": len(entries),
        "records": entries,
        "exclusions": [dict(e) for e in exclusions],
        "selection": dict(selection),
        "notices": list(notices),
    }
    files["index.json"] = snapshot.file_bytes(index)
    return files


def validate_fatwa_dir(path: Path, raw: Optional[Mapping[str, str]] = None) -> dict[str, Any]:
    base = Path(path)
    index = snapshot.read_json(base, "index.json")
    if not isinstance(index, dict) or set(index) != {"schema", "count", "records", "exclusions", "selection", "notices"}:
        raise SnapshotError("index keys do not match the fatwa index schema")
    if index["schema"] != INDEX_SCHEMA:
        raise SnapshotError("wrong index schema")
    entries = index["records"]
    if not isinstance(entries, list) or index["count"] != len(entries) or not entries:
        raise SnapshotError("index count does not match its records")
    for item in index["exclusions"] if isinstance(index["exclusions"], list) else [None]:
        if not isinstance(item, dict) or set(item) != {"url", "reason"} or not all(isinstance(v, str) and v for v in item.values()):
            raise SnapshotError("malformed exclusion entry")
    selection = index["selection"]
    if not isinstance(selection, dict) or not isinstance(selection.get("rationale"), str) or not selection["rationale"]:
        raise SnapshotError("selection rationale is missing")
    starts = selection.get("start_urls")
    if not isinstance(starts, list) or not starts or not all(isinstance(u, str) and u.startswith("https://binbaz.org.sa/") for u in starts):
        raise SnapshotError("selection start_urls are missing")
    if not isinstance(index["notices"], list) or not index["notices"] or not all(isinstance(n, str) and n for n in index["notices"]):
        raise SnapshotError("notices are missing")
    ids: set[str] = set()
    numbers: set[str] = set()
    topics = {t: 0 for t in TOPICS}
    quran = hadith = 0
    noted = notes_total = refs_total = 0
    unmatched: dict[str, list[str]] = {}
    files: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != ENTRY_KEYS:
            raise SnapshotError("malformed index entry")
        reason = entry["audience_reason"]
        if reason is not None and (not isinstance(reason, str) or not reason.strip()):
            raise SnapshotError(f"invalid audience_reason for {entry['id']!r}")
        rid = entry["id"]
        if not isinstance(rid, str) or not ID_PATTERN.match(rid):
            raise SnapshotError(f"bad index id {rid!r}")
        if rid in ids:
            raise SnapshotError(f"duplicate record id {rid}")
        ids.add(rid)
        snapshot.safe_relative(base, entry["file"])
        if entry["file"] != f"records/{rid}.json":
            raise SnapshotError(f"unexpected file path for {rid}: {entry['file']!r}")
        record = snapshot.read_verified(base, entry["file"], entry["sha256"])
        validate_record(record, rid)
        if record["source_record_id"] in numbers:
            raise SnapshotError(f"duplicate fatwa number {record['source_record_id']}")
        numbers.add(record["source_record_id"])
        if (entry["title"], entry["topic"], entry["source_url"], entry["content_sha256"]) != (
            record["title"], record["topic"], record["source"]["url"], record["content_sha256"]
        ):
            raise SnapshotError(f"index entry for {rid} does not match its record")
        if raw is not None:
            if rid not in raw:
                raise SnapshotError(f"{rid}: no raw article to verify against")
            check_against_raw(record, raw[rid])
        topics[record["topic"]] += 1
        quran += len(marked_runs(record["answer"], "quran")) + len(marked_runs(record["question"], "quran"))
        hadith += len(marked_runs(record["answer"], "hadith")) + len(marked_runs(record["question"], "hadith"))
        if record["notes"]:
            noted += 1
            notes_total += len(record["notes"])
        refs_total += sum(1 for field in ("question", "answer") for p in record[field] for r in p if r["kind"] == "noteref")
        stray = unmatched_markers(record)
        if stray:
            unmatched[rid] = stray
        files.add(entry["file"])
    on_disk = {p.relative_to(base).as_posix() for p in (base / "records").rglob("*") if p.is_file()} if (base / "records").is_dir() else set()
    extra = sorted(on_disk - files)
    if extra:
        raise SnapshotError(f"unindexed files in the collection: {extra[:3]!r}")
    return {
        "count": len(entries), "topics": topics, "quran_runs": quran, "hadith_runs": hadith, "exclusions": len(index["exclusions"]),
        "records_with_notes": noted, "notes": notes_total, "noterefs": refs_total, "unmatched_markers": unmatched,
    }
