"""Load and validate the application configuration file."""

import json
import os
from dataclasses import dataclass, field

DEFAULT_PORT = 8080


@dataclass
class DatabaseConfig:
    host: str = "localhost"
    port: int = 5432
    name: str = "app"


@dataclass
class AppConfig:
    port: int = DEFAULT_PORT
    debug: bool = False
    database: DatabaseConfig = field(default_factory=DatabaseConfig)
    allowed_origins: list = field(default_factory=list)


class ConfigError(Exception):
    pass


def read_config_file(path):
    if not os.path.exists(path):
        raise ConfigError(f"config file not found: {path}")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def parse_config(path):
    raw = read_config_file(path)
    db = raw.get("database", {})
    config = AppConfig(
        port=int(raw.get("port", DEFAULT_PORT)),
        debug=bool(raw.get("debug", False)),
        database=DatabaseConfig(
            host=db.get("host", "localhost"),
            port=int(db.get("port", 5432)),
            name=db.get("name", "app"),
        ),
        allowed_origins=list(raw.get("allowed_origins", [])),
    )
    validate_config(config)
    return config


def validate_config(config):
    if not 0 < config.port < 65536:
        raise ConfigError(f"invalid port: {config.port}")
    if not config.database.name:
        raise ConfigError("database name is required")
