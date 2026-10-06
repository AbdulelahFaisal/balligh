"""AI-assisted full fatwa translations, stored as separate artifacts next to the immutable publisher records.

One artifact per (record, locale): content/translations/fatwa/<locale>/<record_id>.json, bound to the record's
content hash and this prompt version. Quran runs and footnote markers are replaced by immutable tokens before any
request and restored from the original record afterwards, so no Quran text is ever sent for translation.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .config import LOCALE_NAMES

SCHEMA = "balligh.fatwa-translation/1"
PROMPT_VERSION = "fatwa-translate-1"
LOCALES = ("en", "ur", "zh-Hans", "id", "bn", "fr")
TOKEN = re.compile(r"⟦([QN])(\d+)⟧")
REVIEW_STATUS = "ai_generated_not_item_reviewed"

SYSTEM = (
    "You translate Arabic fatwas (questions and answers of Shaykh Abd al-Aziz ibn Baz) into {lang} for readers who "
    "are new to Islam. Translate every unit completely and faithfully: keep every condition, exception, negation, "
    "number, name and attribution exactly; never summarize, shorten, omit, soften or add anything. Tokens such as "
    "⟦Q1⟧ stand for Quran quotations and tokens such as ⟦N1⟧ for footnote markers: copy every token exactly once and "
    "unchanged at the matching place, and never write any Quran text or a translation of it. Translate hadith "
    "quotations faithfully. Keep Islamic terms recognisable: the first time, give the usual transliteration with a "
    "short meaning in parentheses when it helps (for example: zakah (obligatory almsgiving)). Return JSON only, in "
    'the form {{"units": [{{"id": "<id>", "text": "<translation>"}}]}} with exactly the same ids in the same order.'
)


def _paragraph_units(prefix: str, paragraphs: list[Any], counter: list[int], tokens: dict[str, dict]) -> list[dict]:
    out = []
    for i, para in enumerate(paragraphs):
        if not isinstance(para, list):
            continue
        parts = []
        for run in para:
            kind = run.get("kind")
            if kind in ("quran", "noteref"):
                counter[0] += 1
                tok = f"⟦{'Q' if kind == 'quran' else 'N'}{counter[0]}⟧"
                tokens[tok] = run
                parts.append(tok)
            else:
                parts.append(str(run.get("text", "")))
        text = "".join(parts)
        if text.strip():
            out.append({"id": f"{prefix}{i}", "text": text})
    return out


def note_paragraphs(note: Any) -> list[Any]:
    if isinstance(note, dict):
        for key in ("paragraphs", "runs", "content"):
            value = note.get(key)
            if isinstance(value, list):
                return value if (value and isinstance(value[0], list)) else [value]
    return []


def record_units(record: dict[str, Any]) -> tuple[list[dict], dict[str, dict]]:
    """Translation units in reading order, and the token → original run map."""
    tokens: dict[str, dict] = {}
    counter = [0]
    units = [{"id": "title", "text": str(record.get("title", ""))}]
    units += _paragraph_units("q", record.get("question") or [], counter, tokens)
    units += _paragraph_units("a", record.get("answer") or [], counter, tokens)
    for n, note in enumerate(record.get("notes") or []):
        units += _paragraph_units(f"n{n}.", note_paragraphs(note), counter, tokens)
    return units, tokens


def build_payload(model: str, record: dict[str, Any], locale: str) -> dict[str, Any]:
    units, _ = record_units(record)
    chars = sum(len(u["text"]) for u in units)
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM.format(lang=LOCALE_NAMES.get(locale, locale))},
            {"role": "user", "content": json.dumps({"target_language": LOCALE_NAMES.get(locale, locale), "units": units}, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "max_tokens": min(32000, max(2048, chars * 3 + 1024)),
    }


def check_units(record: dict[str, Any], got: Any) -> dict[str, str]:
    """The one structural check for creation, serving and resume: ids/order, non-empty, tokens exactly, no truncation."""
    units, _ = record_units(record)
    if not isinstance(got, list) or [u.get("id") if isinstance(u, dict) else None for u in got] != [u["id"] for u in units]:
        raise ValueError("unit_ids_or_order")
    out: dict[str, str] = {}
    for src, dst in zip(units, got):
        text = dst.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"empty_{src['id']}")
        if sorted(TOKEN.findall(src["text"])) != sorted(TOKEN.findall(text)) or "⟦" in TOKEN.sub("", text) or "⟧" in TOKEN.sub("", text):
            raise ValueError(f"tokens_{src['id']}")
        plain = TOKEN.sub("", src["text"]).strip()
        if len(plain) >= 40 and len(TOKEN.sub("", text).strip()) < 0.25 * len(plain):
            raise ValueError(f"truncated_{src['id']}")
        out[src["id"]] = text
    return out


def validate_reply(record: dict[str, Any], body: dict[str, Any]) -> dict[str, str]:
    """Return id → text, or raise ValueError(reason). Checks structure, tokens and truncation; not meaning."""
    choice = (body.get("choices") or [{}])[0]
    if choice.get("finish_reason") != "stop":
        raise ValueError(f"finish_reason_{choice.get('finish_reason')}")
    content = (choice.get("message") or {}).get("content") or ""
    try:
        data = json.loads(content)
    except ValueError:
        raise ValueError("not_json") from None
    return check_units(record, data.get("units") if isinstance(data, dict) else None)


def artifact_path(root: Path, locale: str, rid: str) -> Path:
    return root / locale / f"{rid}.json"


def write_artifact(root: Path, record: dict[str, Any], locale: str, units: dict[str, str], meta: dict[str, Any]) -> Path:
    path = artifact_path(root, locale, record["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "schema": SCHEMA,
        "record_id": record["id"],
        "source_content_sha256": record.get("content_sha256"),
        "locale": locale,
        "prompt_version": PROMPT_VERSION,
        "review_status": REVIEW_STATUS,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **meta,
        "units": [{"id": k, "text": v} for k, v in units.items()],
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_bytes((json.dumps(doc, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
    os.replace(tmp, path)
    return path


def valid_artifact(root: Path, record: dict[str, Any], locale: str) -> Optional[dict[str, Any]]:
    """The stored artifact if it still matches this record, locale and prompt policy, else None (never raises)."""
    try:
        doc = json.loads(artifact_path(root, locale, record["id"]).read_text(encoding="utf-8"))
        if (doc.get("schema") != SCHEMA or doc.get("record_id") != record["id"] or doc.get("locale") != locale
                or doc.get("source_content_sha256") != record.get("content_sha256")
                or doc.get("prompt_version") != PROMPT_VERSION):
            return None
        check_units(record, doc.get("units"))  # the same checks as at creation (G5-E)
        return doc
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def _rebuild(text: str, tokens: dict[str, dict], published) -> list[dict]:
    runs: list[dict] = []
    pos = 0
    for m in TOKEN.finditer(text):
        if m.start() > pos:
            runs.append({"kind": "text", "text": text[pos:m.start()]})
        original = dict(tokens[m.group(0)])
        if original.get("kind") == "quran" and published:
            pub = published(m.group(0))
            if pub:
                original["published"] = pub
        runs.append(original)
        pos = m.end()
    if pos < len(text):
        runs.append({"kind": "text", "text": text[pos:]})
    return runs


def machine_translation(root: Path, record: dict[str, Any], locale: str, published=None) -> Optional[dict[str, Any]]:
    if locale not in LOCALES:
        return None
    doc = valid_artifact(root, record, locale)
    if doc is None:
        return None
    units, tokens = record_units(record)
    text = {u["id"]: u["text"] for u in doc["units"]}
    sections: dict[str, Any] = {"question": [], "answer": [], "notes": []}
    for u in units:
        uid = u["id"]
        if uid == "title":
            continue
        runs = _rebuild(text[uid], tokens, published)
        if uid.startswith("q"):
            sections["question"].append(runs)
        elif uid.startswith("a"):
            sections["answer"].append(runs)
        else:
            note = uid[1:].split(".")[0]
            if not sections["notes"] or sections["notes"][-1]["id"] != note:
                sections["notes"].append({"id": note, "paragraphs": []})
            sections["notes"][-1]["paragraphs"].append(runs)
    return {
        "locale": locale,
        "label": "ai_assisted",
        "review_status": doc.get("review_status"),
        "model": doc.get("model"),
        "prompt_version": doc.get("prompt_version"),
        "generated_at": doc.get("generated_at"),
        "title": text.get("title", ""),
        **sections,
    }


# G5-F: only a complete SINGLE-ayah bracket reference resolves; ranges and lists (68-69, 1، 2) never match,
# so no first-ayah-only translation is shown under a multi-ayah quotation.
_REF = re.compile(r"^\s*\[\s*([^\]:]+?)\s*:\s*([0-9\u0660-\u0669]+)\s*\]")
_DIGITS = str.maketrans("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669", "0123456789")


def quran_refs(record: dict[str, Any]) -> dict[str, tuple[str, int]]:
    """Token → (surah name, ayah) only where the original text right after the quotation gives an explicit reference."""
    out: dict[str, tuple[str, int]] = {}
    counter = 0
    sections = list(record.get("question") or []) + list(record.get("answer") or [])
    sections += [p for note in (record.get("notes") or []) for p in note_paragraphs(note)]
    for para in sections:
        if not isinstance(para, list):
            continue
        for i, run in enumerate(para):
            if run.get("kind") in ("quran", "noteref"):
                counter += 1
                if run.get("kind") == "quran" and i + 1 < len(para):
                    m = _REF.match(str(para[i + 1].get("text", "")))
                    if m:
                        out[f"⟦Q{counter}⟧"] = (m.group(1).strip(), int(m.group(2).translate(_DIGITS)))
    return out


def published_resolver(quran_dir: Path, record: dict[str, Any], locale: str):
    """Returns token → published translation of the meanings of the referenced ayah, from the local corpus only."""
    refs = quran_refs(record)
    if not refs:
        return None
    try:
        index = json.loads((quran_dir / "index.json").read_text(encoding="utf-8"))
        numbers = {s["name_ar"]: s["number"] for s in index.get("surahs", [])}
        editions = index.get("editions")
    except (OSError, ValueError, KeyError, TypeError):
        return None
    edition = None
    if isinstance(editions, dict):
        e = editions.get(locale)
        edition = (e.get("title") or e.get("name")) if isinstance(e, dict) else e
    elif isinstance(editions, list):
        e = next((x for x in editions if isinstance(x, dict) and x.get("locale") == locale), None)
        edition = (e.get("title") or e.get("name") or e.get("id")) if e else None

    def resolve(token: str):
        ref = refs.get(token)
        if not ref or ref[0] not in numbers:
            return None
        surah = numbers[ref[0]]
        try:
            data = json.loads((quran_dir / "surahs" / f"{surah:03d}.json").read_text(encoding="utf-8"))
            ayah = next(a for a in data["ayahs"] if int(a["aya"]) == ref[1])
            tr = (ayah.get("translations") or {}).get(locale) or {}
        except (OSError, ValueError, KeyError, StopIteration, TypeError):
            return None
        text = tr.get("text") if isinstance(tr, dict) else None
        if not text:
            return None
        return {"surah": surah, "ayah": ref[1], "text": text, "footnotes": tr.get("footnotes") or "", "edition": edition}

    return resolve
