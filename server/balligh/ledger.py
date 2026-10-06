import json
from pathlib import Path
from typing import Any, Optional

LEDGER_FILE = "generation-ledger.jsonl"
RESPONSES_DIR = "responses"


class Ledger:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    @property
    def path(self) -> Path:
        return self.directory / LEDGER_FILE

    def append(self, record: dict[str, Any]) -> None:
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        except OSError:
            pass

    def save_response(self, request_id: str, attempt: int, document: dict[str, Any]) -> Optional[str]:
        name = f"{request_id}-a{attempt}.json"
        try:
            target = self.directory / RESPONSES_DIR
            target.mkdir(parents=True, exist_ok=True)
            (target / name).write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError:
            return None
        return f"{RESPONSES_DIR}/{name}"

    def records(self) -> list[dict[str, Any]]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        return [json.loads(line) for line in lines if line.strip()]
