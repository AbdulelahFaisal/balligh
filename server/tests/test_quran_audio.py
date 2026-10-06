import json
import math
import shutil
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from balligh import routes_quran_audio
from balligh.library import quran_audio as qa

LIBRARY = Path(__file__).resolve().parents[2] / "content" / "library"
PAGE = "https://www.mp3quran.net/api/quran_pages_svg/{:03d}.svg"


def row(ayah, start, end, page=1):
    return {"ayah": ayah, "start_time": start, "end_time": end, "page": PAGE.format(page)}


@pytest.fixture(scope="module")
def counts():
    return qa.local_ayah_counts(LIBRARY / "quran")


@pytest.fixture()
def root(tmp_path):
    (tmp_path / "quran").mkdir()
    shutil.copy(LIBRARY / "quran" / "index.json", tmp_path / "quran" / "index.json")
    shutil.copytree(LIBRARY / "quran-audio", tmp_path / "quran-audio")
    return tmp_path


@pytest.fixture()
def client(root):
    app = FastAPI()
    app.include_router(routes_quran_audio.router)
    routes_quran_audio.state.configure(root)
    yield TestClient(app)
    routes_quran_audio.state.configure(routes_quran_audio.LIBRARY_ROOT)


def test_published_dataset_matches_local_quran_and_inspected_examples(counts):
    ds = qa.validate_dataset(LIBRARY / "quran-audio", counts)
    assert ds.manifest["counts"]["timed_ayahs"] == sum(counts.values()) == 6236
    assert ds.manifest["folder_url"] == "https://cdn.mp3quran.net/audio/yasser-dosari/r1/"
    assert ds.surahs[1]["ayahs"][0] == [1, 300, 3240, 1]
    assert ds.surahs[78]["ayahs"][0][3] == 582
    assert ds.surahs[78]["ayahs"][30][:2] == [31, 147360]
    pages = {p["page"]: p["ayahs"] for p in ds.pages}
    assert pages[583][0] == [78, 31]
    assert {s for s, _ in pages[583]} == {78, 79}
    assert pages[583] == sorted(pages[583])
    assert ds.surahs[114]["track_url"].endswith("/r1/114.mp3")


def test_duplicate_and_out_of_range_rows_are_rejected():
    with pytest.raises(qa.AudioDataError, match="duplicate"):
        qa.normalize_surah(1, 2, [row(1, 0, 10), row(1, 10, 20)])
    with pytest.raises(qa.AudioDataError, match="outside"):
        qa.normalize_surah(1, 2, [row(1, 0, 10), row(3, 10, 20)])


def test_gaps_and_bad_times_disable_only_that_start_with_a_reason():
    out = qa.normalize_surah(1, 5, [row(1, 0, 10), row(3, 5, 30), row(4, math.inf, 40), row(5, 50, 45)])
    assert [a[0] for a in out["ayahs"]] == [1]
    reasons = {u["ayah"]: u["reason"] for u in out["unavailable"]}
    assert reasons == {
        2: "no publisher timing row",
        3: "start precedes the previous ayah end",
        4: "non-numeric or non-finite time",
        5: "end is not after start",
    }


def test_ayah_zero_is_an_introduction_not_a_selectable_ayah():
    out = qa.normalize_surah(2, 1, [{"ayah": 0, "start_time": 0, "end_time": 4000, "page": PAGE.format(2)}, row(1, 4000, 9000, 2)])
    assert out["intro"] == {"start_ms": 0.0, "end_ms": 4000.0}
    assert out["ayahs"] == [[1, 4000, 9000, 2]]
    early = qa.normalize_surah(2, 1, [{"ayah": 0, "start_time": 0, "end_time": 4000}, row(1, 3000, 9000, 2)])
    assert early["unavailable"][0]["reason"] == "start precedes the previous ayah end"


def test_page_map_crosses_surahs_in_quran_order():
    a = qa.normalize_surah(78, 2, [row(1, 0, 10, 582), row(2, 10, 20, 583)])
    b = qa.normalize_surah(79, 2, [row(1, 0, 10, 583), row(2, 10, 20, 584)])
    assert qa.build_pages([a, b]) == [
        {"page": 582, "ayahs": [[78, 1]]},
        {"page": 583, "ayahs": [[78, 2], [79, 1]]},
        {"page": 584, "ayahs": [[79, 2]]},
    ]


def test_wrong_read_or_audio_pairing_is_rejected():
    good = {"id": 92, "name": qa.RECITER_AR, "rewaya": qa.REWAYA_AR, "folder_url": qa.FOLDER_URL, "soar_count": 114}
    assert qa.check_pairing([good])["folder_url"] == qa.FOLDER_URL
    with pytest.raises(qa.AudioDataError):
        qa.check_pairing([{**good, "folder_url": "https://server11.mp3quran.net/yasser/"}])
    with pytest.raises(qa.AudioDataError):
        qa.check_pairing([{**good, "id": 93}])


def rewrite(base: Path, name: str, edit) -> None:
    path = base / name
    data = json.loads(path.read_text(encoding="utf-8"))
    edit(data)
    path.write_bytes(qa.file_bytes(data))


def test_dataset_level_tampering_is_rejected(root, counts):
    audio = root / "quran-audio"
    rewrite(audio, "manifest.json", lambda m: m.update(folder_url="https://cdn.mp3quran.net/audio/other/r1/"))
    with pytest.raises(qa.AudioDataError):
        qa.validate_dataset(audio, counts)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s[77]["ayahs"].append(list(s[77]["ayahs"][-1])),
        lambda s: s[77]["ayahs"].pop(5),
        lambda s: s[77]["ayahs"][3].__setitem__(1, 10**9),
        lambda s: s[0]["ayahs"][0].__setitem__(0, 99),
        lambda s: s[113].__setitem__("track_url", "https://cdn.mp3quran.net/audio/other/r1/114.mp3"),
    ],
)
def test_invalid_timing_fails_full_validation_even_with_matching_hashes(root, counts, mutate):
    audio = root / "quran-audio"
    timing = json.loads((audio / "timing.json").read_text(encoding="utf-8"))
    mutate(timing["surahs"])
    manifest = json.loads((audio / "manifest.json").read_text(encoding="utf-8"))
    for rel, data in qa.dataset_files({k: v for k, v in manifest.items() if k != "files"}, timing["surahs"]).items():
        (audio / rel).write_bytes(data)
    with pytest.raises(qa.AudioDataError):
        qa.validate_dataset(audio, counts)


def test_routes_serve_the_validated_dataset(client):
    summary = client.get("/api/library/quran-audio").json()
    assert summary["read_id"] == 92 and summary["counts"]["pages"] == 604
    pages = dict((p, a) for p, a in summary["pages"])
    assert pages[583][0] == [78, 31]
    surah = client.get("/api/library/quran-audio/78").json()
    assert surah["track_url"] == "https://cdn.mp3quran.net/audio/yasser-dosari/r1/078.mp3"
    assert surah["ayahs"][30] == [31, 147360, 152140, 583]
    assert client.get("/api/library/quran-audio/115").status_code == 404


def test_tampered_bytes_return_503(root, client):
    path = root / "quran-audio" / "timing.json"
    path.write_bytes(path.read_bytes().replace(b"147360", b"147361"))
    routes_quran_audio.state.configure(root)
    assert client.get("/api/library/quran-audio").status_code == 503
    assert client.get("/api/library/quran-audio/78").status_code == 503


def test_missing_dataset_returns_503(root, client):
    shutil.rmtree(root / "quran-audio")
    routes_quran_audio.state.configure(root)
    assert client.get("/api/library/quran-audio").status_code == 503
