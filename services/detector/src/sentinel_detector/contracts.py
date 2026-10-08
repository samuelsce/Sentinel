"""Use the generated wire contract; never maintain a separate Python schema."""

import json
import os
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker


def contracts_dir() -> Path:
    configured = os.environ.get("SENTINEL_CONTRACTS_DIR")
    return (
        Path(configured)
        if configured
        else Path(__file__).resolve().parents[4] / "packages/contracts"
    )


def load_validator(filename: str = "security-event.v1.json") -> Draft202012Validator:
    schema = json.loads((contracts_dir() / "schema" / filename).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())
