from __future__ import annotations

from html import escape

from .config import RTL_LOCALES
from .review import ReviewStatus
from .schemas import LessonDraft, LiveGeneration, SourceRecord
from .urls import is_allowed_source_url

STATUS_LABELS: dict[str, tuple[str, str]] = {
    "draft": ("مسودة — لم يقرها أحد", "Draft — not acknowledged"),
    "needs_correction": ("تحتاج تصحيحًا", "Needs correction"),
    "stale": ("تغيّر المحتوى بعد الإقرار — يلزم إقرار جديد", "Changed after acknowledgment — needs a new acknowledgment"),
    "acknowledged_by_user": ("أقرها المستخدم", "Acknowledged by the user"),
    "team_published": ("منشورة ضمن أمثلة الفريق", "Published as a team example"),
}

DERIVATION_LABELS = {
    "verbatim_quote": "Verbatim quotation",
    "team_translation": "Translation of the quoted original (unreviewed unless stated)",
    "derived_explanation": "Explanation derived from the source",
    "machine_translation": "Machine translation (AI draft, not reviewed by a person)",
    "machine_explanation": "AI-generated explanation (not reviewed by a person)",
}

_CSS = """
:root{--paper:#F7F5EF;--ink:#192D32;--action:#176B65;--accent:#C66D4A;--muted:#4A5A5E}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);
font:16px/1.65 "Noto Sans","Noto Sans Arabic","Segoe UI",Tahoma,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.15rem;margin:1.6em 0 .5em}
.banner{border:2px solid var(--accent);padding:10px 12px;border-radius:8px;background:#fff;margin:8px 0}
.card{background:#fff;border:1px solid #D9D4C7;border-radius:10px;padding:14px 16px;margin:12px 0}
blockquote{margin:0 0 10px;padding:8px 12px;border-inline-start:4px solid var(--action);
font-family:"Noto Sans Arabic","Segoe UI",Tahoma,sans-serif;background:var(--paper)}
.src{font-size:.9rem;color:var(--muted);border-top:1px dashed #D9D4C7;margin-top:10px;padding-top:8px}
.src a{color:var(--action)}dt{font-weight:600}dd{margin:0 0 8px}
.status{display:inline-block;padding:2px 10px;border-radius:999px;background:var(--ink);color:#fff;font-size:.9rem}
details{margin-top:8px}summary{cursor:pointer;color:var(--action);font-weight:600}
summary:focus-visible{outline:3px solid var(--action);outline-offset:2px}
.term{background:#fff;border:1px solid #D9D4C7;border-radius:10px;padding:8px 14px;margin:8px 0}
.station{color:var(--action)}
"""


def _dir(locale: str) -> str:
    return "rtl" if locale in RTL_LOCALES else "ltr"


def _source_line(rec: SourceRecord | None, source_id: str) -> str:
    if rec is None:
        return f"<span>Unknown source {escape(source_id)}</span>"
    if rec.rights_status == "teacher_supplied":
        return f"<strong><bdi>{escape(rec.title)}</bdi></strong> · {escape(rec.provenance_note)}"
    parts = [f"<strong><bdi>{escape(rec.title)}</bdi></strong>"]
    if rec.publisher:
        parts.append(f"<bdi>{escape(rec.publisher)}</bdi>")
    if rec.canonical_url and is_allowed_source_url(rec.canonical_url):
        parts.append(
            f'<a href="{escape(rec.canonical_url, quote=True)}" rel="noopener noreferrer">'
            f"{escape(rec.canonical_url)}</a>"
        )
    elif rec.local_reference:
        parts.append(f"Local reference: {escape(rec.local_reference)} (no public URL)")
    parts.append(f"version {escape(rec.source_version)}")
    if rec.is_test_data:
        parts.append("TEST DATA")
    return " · ".join(parts)


def _generation_line(draft: LessonDraft) -> str:
    g = draft.generation
    if isinstance(g, LiveGeneration):
        returned = g.returned_model or "not reported"
        edited = "yes" if g.human_edited else "no"
        return (
            f"Generation: AI draft by {escape(g.provider)} {escape(g.requested_model)} "
            f"(returned model: {escape(returned)}), prompt {escape(g.prompt_version)}, "
            f"request {escape(g.request_id)}, generated {escape(g.generated_at.isoformat())}. "
            f"Edited after generation (as recorded in the draft): {edited}."
        )
    return (
        f"Declared origin: {escape(g.origin)}, as stated in the lesson record. No verified provider record is "
        "attached, so this file does not show whether an AI model was used."
    )


def _span_lines(draft: LessonDraft, span_ids: list[str], sources: dict[str, SourceRecord]) -> list[str]:
    spans = {s.id: s for s in draft.spans}
    lines = []
    for sid in span_ids:
        sp = spans.get(sid)
        if sp is None:
            continue
        lines.append(
            f"{_source_line(sources.get(sp.source_id), sp.source_id)} · characters {sp.start_offset}–{sp.end_offset}"
        )
    return lines


def _quote(draft: LessonDraft, span_id: str, sources: dict[str, SourceRecord]) -> str:
    sp = next((s for s in draft.spans if s.id == span_id), None)
    if sp is None:
        return ""
    ql = sources[sp.source_id].language if sp.source_id in sources else "ar"
    return f'<blockquote lang="{escape(ql, quote=True)}" dir="{_dir(ql)}">{escape(sp.exact_text)}</blockquote>'


def render_lesson_html(
    draft: LessonDraft,
    status: ReviewStatus,
    sources: dict[str, SourceRecord],
    lesson_hash: str,
    reviewer_label: str | None,
) -> str:
    loc = draft.target_locale
    ar_status, en_status = STATUS_LABELS[status]
    out: list[str] = []
    out.append("<!doctype html>")
    out.append(f'<html lang="{escape(loc, quote=True)}" dir="{_dir(loc)}"><head><meta charset="utf-8">')
    out.append(
        '<meta http-equiv="Content-Security-Policy" '
        "content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">"
    )
    out.append('<meta name="viewport" content="width=device-width,initial-scale=1">')
    out.append(f"<title>{escape(draft.title)}</title><style>{_CSS}</style></head><body><main>")
    if draft.is_test_data:
        out.append(
            '<p class="banner" lang="en" dir="ltr"><strong>Test data.</strong> This lesson comes from a neutral '
            "test source. It is not reviewed religious or scholarly content.</p>"
        )
    if isinstance(draft.generation, LiveGeneration):
        out.append(
            '<p class="banner" lang="en" dir="ltr"><strong>AI draft.</strong> Generated by DeepSeek from the '
            "source sentences shown under each card. The translation and explanations have not been reviewed by "
            "a person.</p>"
        )
    out.append(f'<h1 dir="auto">{escape(draft.title)}</h1>')
    reviewer = f" — <bdi>{escape(reviewer_label)}</bdi>" if reviewer_label and status == "acknowledged_by_user" else ""
    out.append(
        f'<p><span class="status" lang="ar" dir="rtl">{escape(ar_status)}</span> '
        f'<span lang="en" dir="ltr">{escape(en_status)}{reviewer}</span></p>'
    )
    if status == "acknowledged_by_user":
        out.append(
            '<p lang="en" dir="ltr" class="src">A local acknowledgment by the person who prepared this file. '
            "It is not a verified identity, an institutional approval, or a scholarly review.</p>"
        )
    out.append(
        '<p class="src" lang="en" dir="ltr">How to use this file: read the cards, open each term, then answer the '
        "question before revealing the answer. This file has no scripts. Choosing and checking an answer, and the "
        "progress record, work only inside the Balligh app; nothing you do here is recorded.</p>"
    )
    text_attrs = f'lang="{escape(loc, quote=True)}" dir="{_dir(loc)}"'
    out.append('<h2 class="station" lang="en" dir="ltr">1. Read</h2>')
    for i, card in enumerate(draft.cards, 1):
        out.append('<section class="card">')
        out.append(f'<h3 lang="en" dir="ltr">Card {i}</h3>')
        if card.quote_id:
            for sid in card.source_span_ids:
                out.append(_quote(draft, sid, sources))
        out.append(f"<p {text_attrs}>{escape(card.text)}</p>")
        if card.editor_note:
            out.append(f'<p class="src" dir="auto">Editor note: {escape(card.editor_note)}</p>')
        out.append(
            '<div class="src" lang="en" dir="ltr">Source: '
            + "<br>".join(_span_lines(draft, card.source_span_ids, sources))
            + f"<br>Type: {escape(DERIVATION_LABELS[card.derivation])} · Review: {escape(en_status)}</div>"
        )
        out.append("</section>")
    out.append('<h2 class="station" lang="en" dir="ltr">2. Understand a term</h2>')
    if not draft.terms:
        out.append('<p lang="en" dir="ltr">This lesson has no terms.</p>')
    for t in draft.terms:
        refs = "<br>".join(_source_line(sources.get(sid), sid) for sid in t.source_ids)
        out.append(
            f'<details class="term"><summary><span lang="ar" dir="rtl">{escape(t.source_form)}</span> '
            f'(<span {text_attrs}>{escape(t.display_form)}</span>)</summary>'
            f"<p {text_attrs}>{escape(t.meaning)}</p>"
            f'<div class="src" lang="en" dir="ltr">Source-level reference: {refs}<br>'
            "Terms point to the whole source, not to a specific passage.</div></details>"
        )
    a = draft.activity
    out.append('<h2 class="station" lang="en" dir="ltr">3. Check your understanding</h2>')
    out.append('<section class="card">')
    out.append(f"<p {text_attrs}>{escape(a.question)}</p><ol {text_attrs}>")
    for o in a.options:
        out.append(f"<li>{escape(o.text)}</li>")
    out.append("</ol>")
    correct = next(o for o in a.options if o.id == a.correct_option_id)
    out.append(
        '<details><summary lang="en" dir="ltr">Show answer</summary>'
        f"<p {text_attrs}><strong>{escape(correct.text)}</strong></p>"
        f"<p {text_attrs}>{escape(a.rationale)}</p></details>"
    )
    out.append('<details><summary lang="en" dir="ltr">Show the evidence</summary>')
    for sid in a.source_span_ids:
        out.append(_quote(draft, sid, sources))
    out.append(
        '<div class="src" lang="en" dir="ltr">Source: '
        + "<br>".join(_span_lines(draft, a.source_span_ids, sources))
        + "<br>A cited passage is not proof that it supports the answer; the reviewer compares them.</div>"
    )
    out.append("</details></section>")
    out.append(
        f'<p class="src" lang="en" dir="ltr">Content hash: <code>{escape(lesson_hash)}</code>. '
        + _generation_line(draft)
        + " Audio: not included. Learner progress: not included.</p>"
    )
    out.append("</main></body></html>")
    return "\n".join(out)
