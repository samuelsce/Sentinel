from unittest.mock import patch

import psycopg

from sentinel_detector.worker import database_ready


def test_database_failure_does_not_leak_credentials(capsys):
    with patch("psycopg.connect", side_effect=psycopg.OperationalError("password=must-not-leak")):
        assert not database_ready("postgresql://user:must-not-leak@invalid/test")
    assert "must-not-leak" not in capsys.readouterr().out
