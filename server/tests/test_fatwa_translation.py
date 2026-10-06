import copy
import hashlib
import json
from pathlib import Path

import pytest

from balligh import fatwa_translation as ft
from helpers import CONTENT

RECORD = json.loads((CONTENT / "library/fatwa/records/binbaz-18975.json").read_text(encoding="utf-8"))


def reply(units, finish="stop"):
    return {"choices": [{"finish_reason": finish, "message": {"content": json.dumps({"units": units}, ensure_ascii=False)}}]}


def good_units():
    units, _ = ft.record_units(RECORD)
    return [{"id": u["id"], "text": "EN " + u["text"].replace("ا", "a")} for u in units]


def test_quran_runs_become_tokens_and_never_reach_the_payload():
    payload = json.dumps(ft.build_payload("deepseek-v4-pro", RECORD, "en"), ensure_ascii=False)
    quran = [r["text"] for p in RECORD["answer"] for r in p if r["kind"] == "quran"]
    assert quran and all(q not in payload for q in quran)
    assert "⟦Q1⟧" in payload and '"thinking": {"type": "disabled"}' in payload


@pytest.mark.parametrize("mutate, reason", [
    (lambda u: u.pop(), "unit_ids_or_order"),
    (lambda u: u.reverse(), "unit_ids_or_order"),
    (lambda u: u[4].update(text=u[4]["text"].replace("⟦Q1⟧", "")), "tokens_a1"),
    (lambda u: u[4].update(text=u[4]["text"] + " ⟦Q9⟧"), "tokens_a1"),
    (lambda u: u[4].update(text="x"), "tokens_a1"),
    (lambda u: u[1].update(text=""), "empty_q0"),
    (lambda u: u[5].update(text="EN"), "truncated_a2"),
])
def test_invalid_replies_are_refused(mutate, reason):
    units = good_units()
    mutate(units)
    with pytest.raises(ValueError) as e:
        ft.validate_reply(RECORD, reply(units))
    assert reason in str(e.value)


def test_length_cutoff_is_refused():
    with pytest.raises(ValueError, match="finish_reason_length"):
        ft.validate_reply(RECORD, reply(good_units(), finish="length"))


def test_artifacts_are_served_only_while_valid(tmp_path: Path):
    units = ft.validate_reply(RECORD, reply(good_units()))
    path = ft.write_artifact(tmp_path, RECORD, "en", units, {"provider": "deepseek", "model": "deepseek-v4-pro"})
    mt = ft.machine_translation(tmp_path, RECORD, "en")
    assert mt["label"] == "ai_assisted" and mt["title"].startswith("EN ")
    quran_runs = [r for p in mt["answer"] for r in p if r["kind"] == "quran"]
    original = [r["text"] for p in RECORD["answer"] for r in p if r["kind"] == "quran"]
    assert [r["text"] for r in quran_runs] == original
    assert ft.machine_translation(tmp_path, RECORD, "ur") is None
    stale = copy.deepcopy(RECORD)
    stale["content_sha256"] = "sha256:" + "0" * 64
    assert ft.machine_translation(tmp_path, stale, "en") is None
    other = copy.deepcopy(RECORD)
    other["id"] = "binbaz-1"
    assert ft.machine_translation(tmp_path, other, "en") is None
    doc = json.loads(path.read_text(encoding="utf-8"))
    for broken in ({**doc, "prompt_version": "old"}, {**doc, "units": doc["units"][:-1]},
                   {**doc, "units": [{**u, "text": u["text"].replace("⟦Q1⟧", "")} for u in doc["units"]]}):
        path.write_text(json.dumps(broken, ensure_ascii=False), encoding="utf-8")
        assert ft.machine_translation(tmp_path, RECORD, "en") is None
    path.write_text("{not json", encoding="utf-8")
    assert ft.machine_translation(tmp_path, RECORD, "en") is None


def test_published_quran_translation_is_resolved_from_the_corpus_by_explicit_reference():
    resolve = ft.published_resolver(CONTENT / "library/quran", RECORD, "en")
    pub = resolve("⟦Q1⟧")
    assert pub and pub["surah"] == 22 and pub["ayah"] == 62 and pub["text"]


def test_publisher_records_are_not_modified_by_translations():
    before = hashlib.sha256((CONTENT / "library/fatwa/records/binbaz-18975.json").read_bytes()).hexdigest()
    ft.machine_translation(CONTENT / "translations" / "fatwa", RECORD, "en")
    after = hashlib.sha256((CONTENT / "library/fatwa/records/binbaz-18975.json").read_bytes()).hexdigest()
    assert before == after


@pytest.mark.parametrize("mutate", [
    lambda d: d["units"][4].update(text="x"),
    lambda d: d["units"][4].update(text=d["units"][4]["text"] + " ⟦Q"),
    lambda d: d["units"][5].update(text="EN"),
])
def test_serving_uses_the_creation_checks(tmp_path: Path, mutate):
    units = ft.validate_reply(RECORD, reply(good_units()))
    path = ft.write_artifact(tmp_path, RECORD, "en", units, {"provider": "deepseek", "model": "deepseek-v4-pro"})
    doc = json.loads(path.read_text(encoding="utf-8"))
    mutate(doc)
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    assert ft.valid_artifact(tmp_path, RECORD, "en") is None
    assert ft.machine_translation(tmp_path, RECORD, "en") is None


def test_known_misattributed_binbaz_1158_artifacts_are_not_served():
    root = CONTENT / "translations" / "fatwa"
    rec = json.loads((CONTENT / "library/fatwa/records/binbaz-1158.json").read_text(encoding="utf-8"))
    for loc in ft.LOCALES:
        assert ft.machine_translation(root, rec, loc) is None


def test_only_a_complete_single_ayah_reference_gets_a_published_translation():
    rec = json.loads((CONTENT / "library/fatwa/records/binbaz-1157.json").read_text(encoding="utf-8"))
    ranged = [tok for tok, run in ft.record_units(rec)[1].items() if tok.startswith("⟦Q")]
    assert ranged
    refs = ft.quran_refs(rec)
    text = json.dumps(rec, ensure_ascii=False)
    assert "الفرقان:68-69" in text.replace(" ", "")
    assert all(r != ("الفرقان", 68) for r in refs.values())
    resolve = ft.published_resolver(CONTENT / "library/quran", rec, "en")
    assert resolve is None or all((resolve(t) or {}).get("surah") != 25 for t in ranged)
    single = ft.published_resolver(CONTENT / "library/quran", RECORD, "en")("⟦Q1⟧")
    assert single and (single["surah"], single["ayah"]) == (22, 62)
