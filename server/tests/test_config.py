import os

from balligh.config import APP_ROOT, ENV_FILE, load_settings, read_env_file


def write(path, text, encoding="utf-8"):
    path.write_bytes(text.encode(encoding))
    return path


def test_env_file_lives_at_the_app_root_not_the_working_directory():
    assert ENV_FILE == APP_ROOT / ".env"
    assert (APP_ROOT / "server" / "balligh" / "config.py").is_file()


def test_env_file_parsing(tmp_path):
    env = write(
        tmp_path / ".env",
        "﻿# local settings\r\n\r\nDEEPSEEK_API_KEY=\"sk-file\"\r\nexport BALLIGH_LEDGER_DIR='off'\r\nBROKEN LINE\r\n=novalue\r\n",
    )
    assert read_env_file(env) == {"DEEPSEEK_API_KEY": "sk-file", "BALLIGH_LEDGER_DIR": "off"}
    assert read_env_file(tmp_path / "missing.env") == {}


def test_process_environment_takes_precedence_over_the_file(tmp_path):
    env = write(tmp_path / ".env", "DEEPSEEK_API_KEY=sk-file\n")
    assert load_settings(env, {}).deepseek_api_key == "sk-file"
    assert load_settings(env, {"DEEPSEEK_API_KEY": "sk-process"}).deepseek_api_key == "sk-process"
    assert load_settings(env, {"DEEPSEEK_API_KEY": "   "}).deepseek_api_key == "sk-file"


def test_absent_key_means_generation_is_not_configured(tmp_path):
    settings = load_settings(tmp_path / "missing.env", {})
    assert settings.deepseek_api_key is None
    assert settings.generation_configured is False


def test_loading_does_not_touch_the_process_environment_or_reveal_the_key(tmp_path):
    env = write(tmp_path / ".env", "DEEPSEEK_API_KEY=sk-secret-value\n")
    before = dict(os.environ)
    settings = load_settings(env, {})
    assert dict(os.environ) == before
    assert "sk-secret-value" not in repr(settings)
    assert settings.generation_configured is True


def test_ledger_location_is_configurable_and_can_be_disabled(tmp_path):
    assert load_settings(None, {}).ledger_dir == APP_ROOT / "var"
    assert load_settings(None, {"BALLIGH_LEDGER_DIR": "off"}).ledger_dir is None
    assert load_settings(None, {"BALLIGH_LEDGER_DIR": str(tmp_path)}).ledger_dir == tmp_path
