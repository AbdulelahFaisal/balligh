import os
import sys
from pathlib import Path

import uvicorn


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
    from balligh.api import create_app
    from balligh.config import load_settings

    environ = {k: v for k, v in os.environ.items() if k != "DEEPSEEK_API_KEY"}
    settings = load_settings(env_file=None, environ=environ)
    if settings.generation_configured:
        raise SystemExit("a provider key is still configured; refusing to start the offline test server")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    uvicorn.run(create_app(settings), host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
