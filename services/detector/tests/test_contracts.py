import copy
import json

import pytest

from sentinel_detector.contracts import contracts_dir, load_validator

FIXTURES = json.loads((contracts_dir() / "fixtures/events.v1.json").read_text(encoding="utf-8"))
EVENT_VALIDATOR = load_validator()
BATCH_VALIDATOR = load_validator("event-batch.v1.json")


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["name"])
def test_shared_event_fixtures(case):
    event = copy.deepcopy(FIXTURES["base"])
    event.update(case["set"])
    for field in case.get("remove", []):
        event.pop(field, None)
    assert EVENT_VALIDATOR.is_valid(event) == case["valid"]


@pytest.mark.parametrize("size", [0, 1, 100, 101])
def test_batch_boundaries(size):
    batch = {"events": [FIXTURES["base"]] * size}
    assert BATCH_VALIDATOR.is_valid(batch) == (0 < size <= 100)


def test_unknown_batch_fields_are_rejected():
    assert not BATCH_VALIDATOR.is_valid({"events": [FIXTURES["base"]], "token": "not-allowed"})
