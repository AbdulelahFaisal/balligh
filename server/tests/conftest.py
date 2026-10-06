import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from balligh.api import create_app
from balligh.config import APP_ROOT
from helpers import offline_settings

FIXTURE = APP_ROOT / "content" / "examples" / "g1-citation-lesson-en.json"


@pytest.fixture(scope="session")
def client() -> TestClient:
    return TestClient(create_app(offline_settings()))


@pytest.fixture
def draft() -> dict:
    return copy.deepcopy(json.loads(FIXTURE.read_text(encoding="utf-8")))


@pytest.fixture
def tests_dir() -> Path:
    return Path(__file__).parent
