import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest

from balligh.library.fetch import Fetcher, FetchError, host_of
from balligh.library import snapshot
from balligh.library.snapshot import SnapshotError, publish, safe_relative, search_key

URL = "https://quranenc.com/api/v1/translation/sura/english_rwwad/114"


def fetcher(tmp_path: Path, handler, **kw) -> Fetcher:
    return Fetcher(tmp_path / "cache", transport=httpx.MockTransport(handler), sleep=lambda s: None, **kw)


def test_cache_hit_needs_no_network(tmp_path):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"result": []})

    first = fetcher(tmp_path, handler).get(URL)
    again = Fetcher(tmp_path / "cache", offline=True).get(URL)
    assert len(calls) == 1 and not first.from_cache and again.from_cache and again.body == first.body
    assert again.retrieved_at == first.retrieved_at


def test_offline_miss_and_corrupt_cache(tmp_path):
    with pytest.raises(FetchError):
        Fetcher(tmp_path / "cache", offline=True).get(URL)
    f = fetcher(tmp_path, lambda r: httpx.Response(200, text="ok"))
    f.get(URL)
    body = next((tmp_path / "cache").rglob("*.body"))
    body.write_bytes(b"tampered")
    assert f.cached(URL) is None


def test_block_is_not_retried_and_is_recorded(tmp_path):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(403, text="Sorry, you have been blocked")

    f = fetcher(tmp_path, handler)
    with pytest.raises(FetchError) as e:
        f.get("https://dorar.net/h/MXnb6eUb")
    assert e.value.status == 403 and len(calls) == 1 and f.failures == [{"url": "https://dorar.net/h/MXnb6eUb", "status": 403}]


def test_server_errors_retry_with_bounded_backoff(tmp_path):
    waits = []
    f = Fetcher(tmp_path / "cache", transport=httpx.MockTransport(lambda r: httpx.Response(503)), sleep=waits.append, attempts=3)
    with pytest.raises(FetchError):
        f.get(URL)
    assert f.network_requests == 3 and f.retries == 2 and waits == [1.5, 3.0]
    assert not list((tmp_path / "cache").rglob("*.body"))


def test_redirects_and_hosts_are_checked(tmp_path):
    f = fetcher(tmp_path, lambda r: httpx.Response(302, headers={"location": "https://evil.example/x"}))
    with pytest.raises(FetchError):
        f.get(URL)
    for bad in ("http://quranenc.com/x", "https://user:pw@quranenc.com/", "https://quranenc.com:8443/", "https://example.com/", "https://quranenc.com/a b"):
        with pytest.raises(FetchError):
            host_of(bad)
    assert host_of("https://www.binbaz.org.sa/fatwas/1") == "binbaz.org.sa"


def test_at_most_two_requests_in_flight_per_host(tmp_path):
    lock = threading.Lock()
    state = {"now": 0, "peak": 0}

    def handler(request):
        with lock:
            state["now"] += 1
            state["peak"] = max(state["peak"], state["now"])
        time.sleep(0.05)
        with lock:
            state["now"] -= 1
        return httpx.Response(200, text=str(request.url))

    f = fetcher(tmp_path, handler)
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(f.get, [f"{URL}?n={i}" for i in range(12)]))
    assert state["peak"] == 2


def test_failed_publish_keeps_previous_snapshot(tmp_path):
    target = tmp_path / "collection"
    publish(target, {"index.json": b"v1"}, lambda p: None)

    def reject(path):
        raise SnapshotError("partial refresh")

    with pytest.raises(SnapshotError):
        publish(target, {"index.json": b"v2-partial"}, reject)
    assert (target / "index.json").read_bytes() == b"v1"
    assert not (tmp_path / "collection.staging").exists()
    with pytest.raises(SnapshotError):
        publish(target, {"../escape.json": b"x"}, lambda p: None)
    assert (target / "index.json").read_bytes() == b"v1" and not (tmp_path / "escape.json").exists()


def test_publish_retries_a_briefly_locked_rename(tmp_path, monkeypatch):
    target = tmp_path / "collection"
    publish(target, {"index.json": b"v1"}, lambda p: None)
    real = snapshot.os.replace
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise PermissionError("locked")
        return real(src, dst)

    monkeypatch.setattr(snapshot.os, "replace", flaky)
    monkeypatch.setattr(snapshot.time, "sleep", lambda s: None)
    publish(target, {"index.json": b"v2"}, lambda p: None)
    assert (target / "index.json").read_bytes() == b"v2" and calls["n"] == 4


def test_publish_restores_previous_when_swap_keeps_failing(tmp_path, monkeypatch):
    target = tmp_path / "collection"
    publish(target, {"index.json": b"v1"}, lambda p: None)
    real = snapshot.os.replace

    def stuck(src, dst):
        if Path(src).name.endswith(".staging"):
            raise PermissionError("locked")
        return real(src, dst)

    monkeypatch.setattr(snapshot.os, "replace", stuck)
    monkeypatch.setattr(snapshot.time, "sleep", lambda s: None)
    with pytest.raises(PermissionError):
        publish(target, {"index.json": b"v2"}, lambda p: None)
    assert (target / "index.json").read_bytes() == b"v1"
    assert not (tmp_path / "collection.staging").exists() and not (tmp_path / "collection.previous").exists()


def test_safe_relative_rejects_escapes(tmp_path):
    for bad in ("../x.json", "/etc/passwd", "a\\b.json", "C:/x.json", "", "records/../../x.json", ".hidden"):
        with pytest.raises(SnapshotError):
            safe_relative(tmp_path, bad)
    assert safe_relative(tmp_path, "records/binbaz-1.json") == (tmp_path / "records" / "binbaz-1.json").resolve()


def test_search_key_only_folds_for_matching():
    original = "إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ"
    assert search_key(original) == "انما الاعمال بالنيات"
    assert original == "إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ"
    assert search_key("Prayer  TIMES") == "prayer times"
