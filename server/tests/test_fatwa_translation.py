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


def test_binbaz_1158_is_served_only_from_the_regenerated_input():
    """The six version-1 artifacts attributed Quran 2:8 to the Prophet. Only a version-2 artifact may be served."""
    root = CONTENT / "translations" / "fatwa"
    rec = json.loads((CONTENT / "library/fatwa/records/binbaz-1158.json").read_text(encoding="utf-8"))
    for loc in ft.LOCALES:
        doc = ft.valid_artifact(root, rec, loc)
        assert doc is None or doc["prompt_version"] == ft.PROMPT_VERSION
    english = ft.valid_artifact(root, rec, "en")
    if english is not None:
        a0 = next(u["text"] for u in english["units"] if u["id"] == "a0")
        lead_in = a0[a0.index("⟦Q1⟧"):a0.index("⟦Q2⟧")].lower()
        assert "prophet" not in lead_in and "messenger" not in lead_in


def test_machine_counts_follow_the_validator_and_refresh_when_files_change(tmp_path: Path):
    assert ft.machine_counts(tmp_path, [RECORD]) == {loc: 0 for loc in ft.LOCALES}
    units = {u["id"]: "EN " + u["text"].replace("ا", "a") for u in ft.record_units(RECORD)[0]}
    path = ft.write_artifact(tmp_path, RECORD, "en", units, {"provider": "deepseek", "model": "deepseek-v4-pro"})
    assert ft.machine_counts(tmp_path, [RECORD])["en"] == 1 and ft.machine_counts(tmp_path, [RECORD])["fr"] == 0
    path.write_text("{}", encoding="utf-8")
    assert ft.machine_counts(tmp_path, [RECORD])["en"] == 0


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


R1158 = json.loads((CONTENT / "library/fatwa/records/binbaz-1158.json").read_text(encoding="utf-8"))


def test_verified_symbols_are_spelled_out_in_the_input_only():
    raw = (CONTENT / "library/fatwa/records/binbaz-1158.json").read_bytes()
    assert ft.has_symbols(R1158) and not ft.has_symbols(RECORD)
    units, _ = ft.record_units(R1158)
    a0 = next(u for u in units if u["id"] == "a0")["text"]
    assert "وقال عز وجل" in a0 and "\uf055" not in a0 and "⟦Q2⟧" in a0
    assert a0.index("وقال عز وجل") < a0.index("⟦Q2⟧")
    payload = json.dumps(ft.build_payload("deepseek-v4-pro", R1158, "en"), ensure_ascii=False)
    assert "\uf055" not in payload and "never attribute a Quran" in payload
    assert (CONTENT / "library/fatwa/records/binbaz-1158.json").read_bytes() == raw
    assert ft.normalize_input("نص بلا رموز") == "نص بلا رموز"


def test_version_1_artifacts_survive_only_for_records_without_symbols(tmp_path: Path):
    def stored(record, version):
        units = {u["id"]: "EN " + u["text"].replace("ا", "a") for u in ft.record_units(record)[0]}
        path = ft.write_artifact(tmp_path, record, "en", units, {"provider": "deepseek", "model": "deepseek-v4-pro"})
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["prompt_version"] = version
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    stored(RECORD, "fatwa-translate-1")
    assert ft.valid_artifact(tmp_path, RECORD, "en") is not None
    stored(R1158, "fatwa-translate-1")
    assert ft.valid_artifact(tmp_path, R1158, "en") is None
    stored(R1158, ft.PROMPT_VERSION)
    assert ft.valid_artifact(tmp_path, R1158, "en") is not None
    stored(RECORD, "fatwa-translate-0")
    assert ft.valid_artifact(tmp_path, RECORD, "en") is None


def test_translated_notes_keep_the_original_note_ids(tmp_path: Path):
    rec = json.loads((CONTENT / "library/fatwa/records/binbaz-1157.json").read_text(encoding="utf-8"))
    units = {u["id"]: "EN " + u["text"].replace("ا", "a") for u in ft.record_units(rec)[0]}
    ft.write_artifact(tmp_path, rec, "en", units, {"provider": "deepseek", "model": "deepseek-v4-pro"})
    mt = ft.machine_translation(tmp_path, rec, "en")
    assert [n["id"] for n in mt["notes"]] == [str(n["id"]) for n in rec["notes"]]


def test_the_publishers_citation_replaces_any_model_written_reference():
    src = "قال تعالى: ⟦Q1⟧ [ص:5] ثم قال: ⟦Q2⟧ [الفرقان:68-69] وقال: ⟦Q3⟧ ثم ⟦Q4⟧ [الحج:62]"
    out = ft.restore_citations(src, "He says: ⟦Q1⟧ [p.5] then: ⟦Q2⟧（放逐章：68-69）and: ⟦Q3⟧ (peace) then ⟦Q4⟧ (as he said) end")
    assert "⟦Q1⟧ \u2068[ص:5]\u2069 then" in out and "p.5" not in out
    assert "⟦Q2⟧ \u2068[الفرقان:68-69]\u2069and" in out and "放逐章" not in out
    assert "⟦Q3⟧ (peace) then" in out                      # no citation in the source: nothing is touched
    assert "⟦Q4⟧ \u2068[الحج:62]\u2069 (as he said) end" in out   # a bracket without a verse number is kept
    assert ft.restore_citations("⟦Q1⟧ [ص:5]", "⟦Q1⟧ and more") == "⟦Q1⟧ \u2068[ص:5]\u2069 and more"  # an omitted citation returns
    assert ft.restore_citations("نص بلا آية", "plain text") == "plain text"


def test_served_translations_carry_the_original_citation_after_each_quotation():
    root = CONTENT / "translations" / "fatwa"
    rec = json.loads((CONTENT / "library/fatwa/records/binbaz-1996.json").read_text(encoding="utf-8"))
    raw = (CONTENT / "library/fatwa/records/binbaz-1996.json").read_bytes()
    for loc in ft.LOCALES:
        mt = ft.machine_translation(root, rec, loc)
        if mt is None:
            continue
        shown = "".join(r.get("text", "") for para in mt["answer"] for r in para if r.get("kind") == "text")
        assert "\u2068[ص:5]\u2069" in shown and "[الصافات:35-36]" in shown
        for wrong in ("p.5", "hal.5", "第5页", "পৃষ্ঠা"):
            assert wrong not in shown
    assert (CONTENT / "library/fatwa/records/binbaz-1996.json").read_bytes() == raw
