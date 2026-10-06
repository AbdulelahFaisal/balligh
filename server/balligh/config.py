import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional

APP_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = APP_ROOT / ".env"

LOCALES: tuple[str, ...] = ("ar", "en", "ur", "zh-Hans", "id", "bn", "fr")
RTL_LOCALES: frozenset[str] = frozenset({"ar", "ur"})
LOCALE_NAMES: dict[str, str] = {
    "ar": "Arabic",
    "en": "English",
    "ur": "Urdu",
    "zh-Hans": "Simplified Chinese",
    "id": "Indonesian",
    "bn": "Bengali",
    "fr": "French",
}

MAX_SOURCE_WORDS = 300
MAX_IMPORT_BYTES = 2 * 1024 * 1024
MAX_JSON3_BYTES = 2 * 1024 * 1024
MAX_SEGMENT_SELECTION_MS = 3 * 60 * 1000

PRODUCT_PROVIDER = "deepseek"
PRODUCT_MODEL = "deepseek-v4-pro"
DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions"
API_KEY_NAME = "DEEPSEEK_API_KEY"


@dataclass(frozen=True)
class GenerationSettings:
    endpoint: str = DEEPSEEK_ENDPOINT
    model: str = PRODUCT_MODEL
    thinking: str = "enabled"
    reasoning_effort: str = "high"
    response_format: str = "json_object"
    max_tokens: int = 16384
    connect_timeout_s: float = 10.0
    attempt_deadline_s: float = 180.0
    max_in_flight: int = 2
    retry_statuses: frozenset[int] = frozenset({429, 500, 503})
    retry_delay_s: float = 2.0
    max_retry_delay_s: float = 5.0


@dataclass(frozen=True)
class Settings:
    content_dir: Path
    web_dist: Path
    ledger_dir: Optional[Path] = None
    deepseek_api_key: Optional[str] = field(default=None, repr=False)
    generation: GenerationSettings = field(default_factory=GenerationSettings)
    audio_enabled: bool = False
    product_model: str = PRODUCT_MODEL

    @property
    def generation_configured(self) -> bool:
        return bool(self.deepseek_api_key)


def read_env_file(path: Path) -> dict[str, str]:
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except (FileNotFoundError, IsADirectoryError, PermissionError, UnicodeDecodeError):
        return {}
    values: dict[str, str] = {}
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].lstrip()
        name, _, value = stripped.partition("=")
        name, value = name.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name:
            values[name] = value
    return values


def load_settings(env_file: Optional[Path] = ENV_FILE, environ: Optional[Mapping[str, str]] = None) -> Settings:
    process = os.environ if environ is None else environ
    stored = read_env_file(env_file) if env_file is not None else {}

    def value(name: str) -> Optional[str]:
        live = process.get(name, "").strip()
        if live:
            return live
        return stored.get(name, "").strip() or None

    ledger = value("BALLIGH_LEDGER_DIR")
    return Settings(
        content_dir=Path(value("BALLIGH_CONTENT_DIR") or APP_ROOT / "content"),
        web_dist=Path(value("BALLIGH_WEB_DIST") or APP_ROOT / "web" / "dist"),
        ledger_dir=None if ledger == "off" else Path(ledger or APP_ROOT / "var"),
        deepseek_api_key=value(API_KEY_NAME),
    )
