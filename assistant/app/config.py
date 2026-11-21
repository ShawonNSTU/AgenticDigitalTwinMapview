"""All runtime settings, read once from environment variables (.env is loaded automatically)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    return _env(name, str(default)).lower() in {"1", "true", "yes", "on"}


def _env_list(name: str) -> list[str]:
    return [x.strip() for x in _env(name).split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    # --- LLM (Ollama) ---
    ollama_model: str = field(default_factory=lambda: _env("OLLAMA_MODEL", "gpt-oss:20b"))
    # PLACEHOLDER: point this at your Ollama server (the machine that has the model pulled), e.g. http://10.0.0.5:11434
    ollama_base_url: str = field(default_factory=lambda: _env("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/"))
    # Only for an Ollama behind an authenticating proxy / hosted Ollama: sent as "Authorization: Bearer <key>".
    ollama_api_key: str = field(default_factory=lambda: _env("OLLAMA_API_KEY"))
    # How long Ollama keeps the model loaded after a turn ("5m", "1h", "-1" = forever). Avoids a cold start per chat.
    ollama_keep_alive: str = field(default_factory=lambda: _env("OLLAMA_KEEP_ALIVE", "30m"))
    # gpt-oss accepts "low" | "medium" | "high"; other thinking models accept "true"/"false"; empty = model default.
    ollama_think: str = field(default_factory=lambda: _env("OLLAMA_THINK", "low"))
    llm_timeout_s: float = field(default_factory=lambda: _env_float("LLM_TIMEOUT_S", 60.0))
    llm_temperature: float = field(default_factory=lambda: _env_float("LLM_TEMPERATURE", 0.0))
    # Use Ollama's JSON-schema constrained decoding. Turn off only if the model misbehaves with it.
    llm_structured_output: bool = field(default_factory=lambda: _env_bool("LLM_STRUCTURED_OUTPUT", True))
    # Extra attempts when the model returns invalid JSON (the error is fed back to the model).
    llm_max_retries: int = field(default_factory=lambda: _env_int("LLM_MAX_RETRIES", 2))

    # --- SmartThings API ---
    # In the digital twin PoC this is the twin's SmartThings-compatible API: commands go through the twin (3D view,
    # zone rules, guest permissions) and on to the real device when it is linked. Standalone, set it to
    # https://api.smartthings.com/v1/devices.
    st_api_base_url: str = field(
        default_factory=lambda: _env("IOT_API_BASE_URL", "http://localhost:3000/api/st/v1/devices").rstrip("/")
    )
    st_default_token: str = field(default_factory=lambda: _env("IOT_API_BEARER_TOKEN"))
    st_timeout_s: float = field(default_factory=lambda: _env_float("ST_TIMEOUT_S", 15.0))
    # When true, commands are NOT sent to SmartThings (useful for local testing).
    st_dry_run: bool = field(default_factory=lambda: _env_bool("ST_DRY_RUN", False))

    # The twin's read-only floor and diagnostics API (host / technician only). Default: next to IOT_API_BASE_URL.
    twin_api_base_url: str = field(default_factory=lambda: _env("TWIN_API_BASE_URL"))
    # Diagnostics skill (find devices by health, explain a fault from the twin's evidence). Needs the twin API.
    diagnostics_enabled: bool = field(default_factory=lambda: _env_bool("DIAGNOSTICS_ENABLED", True))

    # The web app's address as a guest or staff member opens it (for check-in links the assistant hands out).
    web_public_url: str = field(default_factory=lambda: _env("WEB_PUBLIC_URL", "http://localhost:3000").rstrip("/"))

    # --- Conversation / prompt budget ---
    history_max_messages: int = field(default_factory=lambda: _env_int("HISTORY_MAX_MESSAGES", 6))
    history_max_chars: int = field(default_factory=lambda: _env_int("HISTORY_MAX_CHARS", 300))
    max_device_candidates: int = field(default_factory=lambda: _env_int("MAX_DEVICE_CANDIDATES", 25))
    # Most devices whose live status one answer may read (keeps the status prompt small).
    max_status_devices: int = field(default_factory=lambda: _env_int("MAX_STATUS_DEVICES", 15))

    # --- Behaviour ---
    bot_name: str = field(default_factory=lambda: _env("BOT_NAME", "SmartThingsBot"))
    # "template" = deterministic confirmation text (no hallucination); "llm" = model phrases it.
    reply_style: str = field(default_factory=lambda: _env("REPLY_STYLE", "template").lower())
    # Comma separated skill names. Empty = every registered skill.
    enabled_skills: list[str] = field(default_factory=lambda: _env_list("ENABLED_SKILLS"))
    location_data_path: Path = field(
        default_factory=lambda: PROJECT_ROOT / _env("LOCATION_DATA_PATH", "data/locations.json")
    )
    # Location skill is off by default: room/location questions will go through a future API.
    location_skill_enabled: bool = field(default_factory=lambda: _env_bool("LOCATION_SKILL_ENABLED", False))
    # Rooms and the devices in each room (see data/rooms.example.json).
    rooms_data_path: Path = field(
        default_factory=lambda: PROJECT_ROOT / _env("ROOMS_DATA_PATH", "data/rooms.json")
    )

    # --- Floor-plan reading (POST /floorplan/parse) ---
    # Image processing needs no LLM. A Claude key adds names and interior items from vision; empty = image processing only.
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    vision_model: str = field(default_factory=lambda: _env("VISION_MODEL", "claude-sonnet-5-5"))

    # --- Robustness ---
    # Turns running at once. A local Ollama serves one model call at a time, so extra turns wait their turn.
    max_concurrent_turns: int = field(default_factory=lambda: _env_int("MAX_CONCURRENT_TURNS", 4))
    # Longest a whole turn may take (routing + skill + device calls); then the user gets a clear message.
    turn_timeout_s: float = field(default_factory=lambda: _env_float("TURN_TIMEOUT_S", 90.0))

    # --- Server ---
    host: str = field(default_factory=lambda: _env("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("PORT", 8100))
    log_level: str = field(default_factory=lambda: _env("LOG_LEVEL", "INFO").upper())


    @property
    def twin_base(self) -> str:
        """Base URL of the twin API: TWIN_API_BASE_URL, else IOT_API_BASE_URL with its trailing /devices -> /twin."""
        if self.twin_api_base_url:
            return self.twin_api_base_url.rstrip("/")
        base = self.st_api_base_url
        return (base[: -len("/devices")] if base.endswith("/devices") else base) + "/twin"


settings = Settings()
