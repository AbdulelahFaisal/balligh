import json
import re
from pathlib import Path

import pytest

LIVE_EXPORT = Path(__file__).parent / "fixtures" / "live" / "g2-live-export-en-f034a415.json"
MALICIOUS = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'><a href="javascript:alert(3)">x</a>'


@pytest.fixture
def live_draft() -> dict:
    return json.loads(LIVE_EXPORT.read_text(encoding="utf-8"))["draft"]


def export_html(client, draft, review=None) -> str:
    r = client.post("/api/export/html", json={"draft": draft, "review": review})
    assert r.status_code == 200, r.text
    return r.text


def ack(client, draft):
    r = client.post(
        "/api/reviews/acknowledge",
        json={"draft": draft, "reviewer_label": "G3 tester", "confirmed_compared_with_source": True},
    )
    assert r.status_code == 200, r.text
    return r.json()


def section(html: str, start: str, end: str) -> str:
    return html[html.index(start) : html.index(end, html.index(start))]


def test_live_html_has_three_stations_and_activity_evidence_from_s2(client, live_draft):
    html = export_html(client, live_draft)
    for heading in ("1. Read", "2. Understand a term", "3. Check your understanding"):
        assert heading in html
    s2 = next(s for s in live_draft["spans"] if s["id"] == "s2")
    s4 = next(s for s in live_draft["spans"] if s["id"] == "s4")
    evidence = section(html, "<summary lang=\"en\" dir=\"ltr\">Show the evidence</summary>", "</details>")
    assert s2["exact_text"] in evidence
    assert f"characters {s2['start_offset']}–{s2['end_offset']}" in evidence
    assert s4["exact_text"] not in evidence
    assert "not proof that it supports the answer" in evidence
    answer = section(html, "<summary lang=\"en\" dir=\"ltr\">Show answer</summary>", "</details>")
    assert "The book or article name and the place of the phrase" in answer


def test_live_html_term_references_are_source_level(client, live_draft):
    html = export_html(client, live_draft)
    terms = re.findall(r'<details class="term">.*?</details>', html, re.S)
    assert len(terms) == len(live_draft["terms"]) == 4
    for block, term in zip(terms, live_draft["terms"]):
        assert f'<span lang="ar" dir="rtl">{term["source_form"]}</span>' in block
        assert "Source-level reference:" in block
        assert "not to a specific passage" in block
        assert "characters" not in block
        assert "<blockquote" not in block


def test_portable_html_keeps_notices_and_stays_script_free(client, live_draft):
    html = export_html(client, live_draft)
    assert "Test data." in html
    assert "AI draft." in html
    assert "Learner progress: not included." in html
    assert "nothing you do here is recorded" in html
    assert "default-src 'none'" in html
    assert "<script" not in html.lower()
    assert not re.search(r'href="(?!https://)', html)
    assert re.search(r"Content hash: <code>sha256:[0-9a-f]{64}</code>", html)
    assert html.count('<blockquote lang="ar" dir="rtl">') >= 4


def test_portable_html_shows_a_local_acknowledgment_truthfully(client, live_draft):
    res = ack(client, live_draft)
    html = export_html(client, live_draft, res["review"])
    assert "Acknowledged by the user — <bdi>G3 tester</bdi>" in html
    assert "not a verified identity, an institutional approval, or a scholarly review" in html


def test_injection_in_newly_editable_fields_is_inert(client, live_draft):
    live_draft["terms"][0]["display_form"] = MALICIOUS
    live_draft["terms"][1]["meaning"] = MALICIOUS
    live_draft["activity"]["options"][2]["text"] = MALICIOUS
    live_draft["activity"]["rationale"] = MALICIOUS
    html = export_html(client, live_draft)
    assert "<script" not in html.lower()
    assert not re.search(r"<img", html, re.I)
    assert "javascript:" not in html.replace("javascript:alert(3)&quot;", "")
    assert html.count("&lt;script&gt;") >= 4


@pytest.mark.parametrize(
    "edit",
    [
        lambda d: d["terms"][0].__setitem__("display_form", "citation"),
        lambda d: d["terms"][0].__setitem__("meaning", "Naming where a quotation comes from."),
        lambda d: d["activity"]["options"][0].__setitem__("text", "Only the author's full name"),
        lambda d: d["activity"].__setitem__("correct_option_id", "a"),
        lambda d: d["activity"].__setitem__("rationale", "The source asks for the name and the place."),
    ],
    ids=["term_display", "term_meaning", "option_text", "correct_option", "rationale"],
)
def test_g3_editable_fields_change_the_hash_and_stale_the_ack(client, live_draft, edit):
    res = ack(client, live_draft)
    edit(live_draft)
    ev = client.post("/api/drafts/validate", json={"draft": live_draft, "review": res["review"]}).json()
    assert ev["valid"] is True
    assert ev["lesson_hash"] != res["lesson_hash"]
    assert ev["status"] == "stale"


@pytest.mark.parametrize(
    "path",
    [
        ("terms", 0, "meaning"),
        ("terms", 1, "display_form"),
        ("activity", "options", 1, "text"),
        ("activity", "rationale"),
        ("activity", "question"),
        ("cards", 0, "text"),
        ("title",),
    ],
    ids=lambda p: ".".join(str(x) for x in p),
)
def test_blank_text_is_an_in_progress_draft_that_cannot_be_acknowledged_or_exported(client, live_draft, path):
    node = live_draft
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = "   "
    ev = client.post("/api/drafts/validate", json={"draft": live_draft}).json()
    assert ev["valid"] is False
    assert ev["status"] == "needs_correction"
    assert any(e.endswith("is blank") for e in ev["errors"])
    r = client.post(
        "/api/reviews/acknowledge",
        json={"draft": live_draft, "reviewer_label": "x", "confirmed_compared_with_source": True},
    )
    assert r.status_code == 422
    assert client.post("/api/export/html", json={"draft": live_draft}).status_code == 422
    saved = client.post("/api/export/json", json={"draft": live_draft}).json()
    assert saved["status_at_export"] == "needs_correction"


def test_reimported_g3_export_keeps_edits_and_drops_the_acknowledgment(client, live_draft):
    live_draft["terms"][0]["meaning"] = "Naming the source of a quotation so readers can check it."
    live_draft["activity"]["options"][3]["text"] = "Which language the book is written in"
    live_draft["presentation"]["font_scale"] = 1.25
    res = ack(client, live_draft)
    envelope = client.post("/api/export/json", json={"draft": live_draft, "review": res["review"]}).json()
    assert envelope["status_at_export"] == "acknowledged_by_user"
    r = client.post("/api/drafts/import", content=json.dumps(envelope, ensure_ascii=False).encode("utf-8"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "draft"
    assert "local_review" in body["discarded_claims"]
    assert body["lesson_hash"] == res["lesson_hash"]
    assert body["draft"] == live_draft


def test_a_saved_in_progress_draft_with_blank_text_still_imports_as_needing_correction(client, live_draft):
    live_draft["terms"][2]["meaning"] = " "
    envelope = client.post("/api/export/json", json={"draft": live_draft}).json()
    r = client.post("/api/drafts/import", content=json.dumps(envelope, ensure_ascii=False).encode("utf-8"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "needs_correction"
    assert r.json()["errors"] == ["term t3 meaning is blank"]
    assert r.json()["draft"]["terms"][2]["meaning"] == " "
