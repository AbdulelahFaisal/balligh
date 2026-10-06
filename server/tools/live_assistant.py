import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

APP = Path(__file__).resolve().parents[2]
OUT = APP / "docs" / "review" / "G4-C1" / "live"
BUDGET = 8
MAX_PER_QUESTION = 2

QUESTIONS = [
    {"n": 1, "locale": "ar", "mode": "fatwa", "record": "binbaz-18975",
     "question": "ما الذي تدل عليه شهادة أن لا إله إلا الله بحسب هذه الفتوى؟"},
    {"n": 2, "locale": "en", "mode": "hadith", "record": "hadeethenc-65000",
     "question": "According to this hadith and its published explanation, what is Islam built on?"},
    {"n": 3, "locale": "ur", "mode": "site_help", "record": None,
     "question": "میں جہاں پڑھنا چھوڑا تھا وہاں سے دوبارہ کیسے شروع کروں؟"},
    {"n": 4, "locale": "zh-Hans", "mode": "site_help", "record": None,
     "question": "我可以在这个网站上收听古兰经诵读吗？怎么使用？"},
    {"n": 5, "locale": "id", "mode": "hadith", "record": "hadeethenc-5351",
     "question": "Menurut hadis ini dan penjelasannya, siapakah orang yang kuat itu?"},
    {"n": 6, "locale": "bn", "mode": "fatwa", "record": "binbaz-2774",
     "question": "এই ফতোয়া অনুযায়ী, যে ব্যক্তি ঘুমিয়ে থাকার কারণে ফজরের নামাজের সময় পার করে ফেলে, তার কী করণীয়?"},
    {"n": 7, "locale": "fr", "mode": "site_help", "record": None,
     "question": "Puis-je préparer une leçon à partir de n'importe quelle fatwa de la bibliothèque ?"},
]


def context(client: httpx.Client, q: dict) -> dict | None:
    if q["mode"] == "site_help":
        return None
    path = "fatwas" if q["mode"] == "fatwa" else "hadith"
    rec = client.get(f"/api/library/{path}/{q['record']}", params={"locale": q["locale"]}).json()["record"]
    return {"record_id": rec["id"], "sha256": rec["content_sha256"], "version": rec["schema"]}


def main() -> int:
    port = int(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / "live-summary.json").exists():
        print("refusing: live-summary.json exists; the live pilot is not repeated silently")
        return 2
    used = 0
    rows = []
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=400.0) as client:
        health = client.get("/api/health").json()["generation"]
        if not health.get("configured"):
            print("live verification pending: the server is not configured")
            return 3
        for q in QUESTIONS:
            if used + MAX_PER_QUESTION > BUDGET:
                rows.append({"n": q["n"], "outcome": "skipped_budget"})
                continue
            body = {"request_id": str(uuid.uuid4()), "mode": q["mode"], "locale": q["locale"],
                    "question": q["question"], "context": context(client, q)}
            started = datetime.now(timezone.utc).isoformat()
            t0 = time.monotonic()
            r = client.post("/api/assistant/ask", json=body)
            wall = int((time.monotonic() - t0) * 1000)
            data = r.json()
            calls = (data.get("meta") or {}).get("provider_calls") if r.status_code == 200 else (data.get("detail") or {}).get("provider_calls", 0)
            used += int(calls or 0)
            record = {"n": q["n"], "started_at": started, "wall_ms": wall, "http_status": r.status_code,
                      "request": body, "response": data}
            name = f"{q['n']:02d}-{q['locale']}-{q['mode']}.json"
            (OUT / name).write_bytes((json.dumps(record, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
            meta = data.get("meta") or {}
            rows.append({"n": q["n"], "file": name, "locale": q["locale"], "mode": q["mode"], "record": q["record"],
                         "http_status": r.status_code, "status": data.get("status") or (data.get("detail") or {}).get("code"),
                         "provider_calls": calls, "latency_ms": meta.get("latency_ms"), "wall_ms": wall,
                         "model": meta.get("model"), "prompt_version": meta.get("prompt_version"),
                         "usage": meta.get("usage"), "pins": data.get("pins"),
                         "cited": [e["id"] for e in data.get("evidence", [])]})
            print(f"{q['n']} {q['locale']} {q['mode']} http={r.status_code} status={rows[-1]['status']} calls={calls} wall_ms={wall}")
        quran = {"request_id": str(uuid.uuid4()), "mode": "quran", "locale": "en", "question": "What does this ayah say?"}
        s = client.get("/api/library/quran/78", params={"locale": "en"}).json()
        quran["context"] = {"surah": 78, "ayah": 31, "sha256": s["content_sha256"], "version": s["edition"]["version"], "tafsir": False}
        qr = client.post("/api/assistant/ask", json=quran)
        (OUT / "quran-zero-provider.json").write_bytes(
            (json.dumps({"http_status": qr.status_code, "request": quran, "response": qr.json()}, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
        print(f"quran http={qr.status_code} provider_calls={qr.json().get('meta', {}).get('provider_calls')}")
    summary = {"budget": BUDGET, "provider_calls_total": used, "questions": rows,
               "settings": {"model": health.get("model"), "provider": health.get("provider")}}
    (OUT / "live-summary.json").write_bytes((json.dumps(summary, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
    print(f"provider calls used: {used} of {BUDGET}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
