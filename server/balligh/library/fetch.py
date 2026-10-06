from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urljoin, urlsplit

import httpx

USER_AGENT = "Balligh-library-importer/1.0 (offline reader snapshot; hackathon project)"
ALLOWED_HOSTS = frozenset({"binbaz.org.sa", "hadeethenc.com", "quranenc.com", "dorar.net", "mp3quran.net"})
MAX_IN_FLIGHT_PER_HOST = 2
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_REDIRECTS = 3
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


class FetchError(Exception):
    def __init__(self, message: str, url: str, status: Optional[int] = None):
        super().__init__(message)
        self.url = url
        self.status = status


def host_of(url: str) -> str:
    if not isinstance(url, str) or len(url) > 2000 or any(c.isspace() or ord(c) < 32 for c in url):
        raise FetchError("refusing a malformed url", str(url)[:200])
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise FetchError("refusing a malformed url", url[:200]) from None
    if parts.scheme != "https" or parts.username or parts.password or port not in (None, 443):
        raise FetchError("refusing a non-https or credentialed url", url[:200])
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host not in ALLOWED_HOSTS:
        raise FetchError(f"refusing host {host!r}", url[:200])
    return host


@dataclass(frozen=True)
class Fetched:
    url: str
    final_url: str
    status: int
    content_type: str
    body: bytes
    retrieved_at: str
    from_cache: bool

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.body).hexdigest()

    def text(self) -> str:
        return self.body.decode("utf-8")

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


class Fetcher:
    def __init__(
        self,
        cache_dir: Path,
        *,
        offline: bool = False,
        transport: Optional[httpx.BaseTransport] = None,
        sleep: Callable[[float], None] = time.sleep,
        timeout_s: float = 20.0,
        attempts: int = 3,
        backoff_s: float = 1.5,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ):
        self.cache_dir = Path(cache_dir)
        self.offline = offline
        self.sleep = sleep
        self.attempts = max(1, attempts)
        self.backoff_s = backoff_s
        self.now = now
        self.client = httpx.Client(
            timeout=httpx.Timeout(timeout_s, connect=10.0),
            follow_redirects=False,
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"},
            transport=transport,
        )
        self._lock = threading.Lock()
        self._slots: dict[str, threading.BoundedSemaphore] = {}
        self.network_requests = 0
        self.retries = 0
        self.failures: list[dict[str, Any]] = []

    def close(self) -> None:
        self.client.close()

    def _slot(self, host: str) -> threading.BoundedSemaphore:
        with self._lock:
            if host not in self._slots:
                self._slots[host] = threading.BoundedSemaphore(MAX_IN_FLIGHT_PER_HOST)
            return self._slots[host]

    def _paths(self, url: str) -> tuple[Path, Path]:
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()
        folder = self.cache_dir / key[:2]
        return folder / f"{key}.body", folder / f"{key}.meta.json"

    def cached(self, url: str) -> Optional[Fetched]:
        body_path, meta_path = self._paths(url)
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            body = body_path.read_bytes()
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict) or meta.get("url") != url:
            return None
        if hashlib.sha256(body).hexdigest() != meta.get("sha256"):
            return None
        return Fetched(url, meta["final_url"], meta["status"], meta["content_type"], body, meta["retrieved_at"], True)

    def _store(self, item: Fetched) -> None:
        body_path, meta_path = self._paths(item.url)
        body_path.parent.mkdir(parents=True, exist_ok=True)
        meta = {
            "url": item.url,
            "final_url": item.final_url,
            "status": item.status,
            "content_type": item.content_type,
            "retrieved_at": item.retrieved_at,
            "sha256": item.sha256,
            "bytes": len(item.body),
        }
        for path, data in ((body_path, item.body), (meta_path, json.dumps(meta, indent=1).encode("utf-8"))):
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, path)

    def _once(self, url: str) -> httpx.Response:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            host_of(current)
            with self._lock:
                self.network_requests += 1
            response = self.client.get(current)
            if response.status_code in (301, 302, 303, 307, 308) and "location" in response.headers:
                current = urljoin(current, response.headers["location"])
                continue
            return response
        raise FetchError("too many redirects", url)

    def get(self, url: str) -> Fetched:
        host = host_of(url)
        hit = self.cached(url)
        if hit is not None:
            return hit
        if self.offline:
            raise FetchError("not in the cache and the importer is offline", url)
        last = "no attempt"
        with self._slot(host):
            for attempt in range(self.attempts):
                try:
                    response = self._once(url)
                except httpx.HTTPError as e:
                    last = type(e).__name__
                else:
                    if response.status_code == 200:
                        body = response.content
                        if len(body) > MAX_BODY_BYTES:
                            raise FetchError("response is larger than the importer limit", url, 200)
                        item = Fetched(
                            url=url,
                            final_url=str(response.url),
                            status=200,
                            content_type=response.headers.get("content-type", ""),
                            body=body,
                            retrieved_at=self.now().replace(microsecond=0).isoformat(),
                            from_cache=False,
                        )
                        self._store(item)
                        return item
                    if response.status_code not in RETRY_STATUSES:
                        with self._lock:
                            self.failures.append({"url": url, "status": response.status_code})
                        raise FetchError(f"HTTP {response.status_code}", url, response.status_code)
                    last = f"HTTP {response.status_code}"
                if attempt + 1 < self.attempts:
                    with self._lock:
                        self.retries += 1
                    self.sleep(min(self.backoff_s * (2**attempt), 10.0))
        with self._lock:
            self.failures.append({"url": url, "status": None, "reason": last})
        raise FetchError(f"{last} after {self.attempts} attempts", url)
