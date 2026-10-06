import subprocess
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]

PROBE = r"""
import socket, sys
def _blocked(*a, **k):
    raise RuntimeError("network access during import")
socket.socket.connect = _blocked
socket.create_connection = _blocked
socket.getaddrinfo = _blocked
import balligh, balligh.api, balligh.schemas, balligh.sources, balligh.review, balligh.hashing
import balligh.export_html, balligh.ingestion.json3, balligh.lesson_pipeline, balligh.providers.deepseek, balligh.ledger
import balligh.library.catalog, balligh.library.fetch, balligh.library.quran, balligh.library.fatwa, balligh.library.hadith
app = balligh.api.create_app()
assert app.state.library.errors == {}, app.state.library.errors
heavy = [m for m in ("torch", "faster_whisper", "ctranslate2", "openai", "yt_dlp", "requests") if m in sys.modules]
print("HEAVY=" + ",".join(heavy))
"""


def test_import_without_network_or_gpu():
    r = subprocess.run([sys.executable, "-c", PROBE], cwd=SERVER_DIR, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert "HEAVY=\n" in r.stdout or r.stdout.strip() == "HEAVY="
