import asyncio
import re
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from ..config import GenerationSettings


class ProviderFailure(Exception):
    def __init__(
        self,
        kind: str,
        latency_ms: int,
        status: Optional[int] = None,
        retry_after: Optional[float] = None,
        error_type: Optional[str] = None,
    ) -> None:
        super().__init__(kind if status is None else f"{kind} {status}")
        self.kind = kind
        self.latency_ms = latency_ms
        self.status = status
        self.retry_after = retry_after
        self.error_type = error_type


@dataclass(frozen=True)
class ProviderReply:
    body: dict[str, Any]
    latency_ms: int


def parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def provider_error_type(response: httpx.Response) -> Optional[str]:
    try:
        data = response.json()
    except ValueError:
        return None
    error = data.get("error") if isinstance(data, dict) else None
    kind = error.get("type") if isinstance(error, dict) else None
    if isinstance(kind, str) and re.fullmatch(r"[a-z_]{1,40}", kind):
        return kind
    return None


class DeepSeekClient:
    def __init__(
        self,
        api_key: str,
        settings: GenerationSettings,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._api_key = api_key
        self._settings = settings
        self._transport = transport

    def __repr__(self) -> str:
        return f"DeepSeekClient(endpoint={self._settings.endpoint!r})"

    async def create(self, payload: dict[str, Any]) -> ProviderReply:
        cfg = self._settings
        timeout = httpx.Timeout(cfg.attempt_deadline_s, connect=cfg.connect_timeout_s)
        transport = self._transport or httpx.AsyncHTTPTransport(retries=0)
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        started = time.monotonic()

        def elapsed() -> int:
            return int((time.monotonic() - started) * 1000)

        try:
            async with asyncio.timeout(cfg.attempt_deadline_s):
                async with httpx.AsyncClient(transport=transport, timeout=timeout) as client:
                    response = await client.post(cfg.endpoint, json=payload, headers=headers)
        except TimeoutError:
            raise ProviderFailure("timeout", elapsed()) from None
        except httpx.ConnectTimeout:
            raise ProviderFailure("network", elapsed()) from None
        except httpx.TimeoutException:
            raise ProviderFailure("timeout", elapsed()) from None
        except httpx.TransportError:
            raise ProviderFailure("network", elapsed()) from None
        if response.status_code != 200:
            raise ProviderFailure(
                "http",
                elapsed(),
                status=response.status_code,
                retry_after=parse_retry_after(response.headers.get("retry-after")),
                error_type=provider_error_type(response),
            )
        try:
            body = response.json()
        except ValueError:
            raise ProviderFailure("protocol", elapsed(), status=200) from None
        if not isinstance(body, dict):
            raise ProviderFailure("protocol", elapsed(), status=200)
        return ProviderReply(body=body, latency_ms=elapsed())
