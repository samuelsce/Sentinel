from unittest.mock import patch

import psycopg

from sentinel_detector.worker import database_ready, main


def test_database_failure_does_not_leak_credentials(capsys):
    with patch("psycopg.connect", side_effect=psycopg.OperationalError("password=must-not-leak")):
        assert not database_ready("postgresql://user:must-not-leak@invalid/test")
    assert "must-not-leak" not in capsys.readouterr().out


def test_worker_drains_ready_jobs_before_sleeping(monkeypatch):
    class Stop:
        def __init__(self):
            self.stopped = False
            self.sleeps = []

        def is_set(self):
            return self.stopped

        def set(self):
            self.stopped = True

        def wait(self, seconds):
            self.sleeps.append(seconds)
            self.stopped = True

    stop = Stop()
    from unittest.mock import Mock

    detector = Mock()
    detector.run_once.side_effect = [True, True, False]
    monkeypatch.setenv("DETECTOR_DATABASE_URL", "private-test-placeholder")
    with (
        patch("sys.argv", ["sentinel-detector"]),
        patch("sentinel_detector.worker.threading.Event", return_value=stop),
        patch("sentinel_detector.worker.signal.signal"),
        patch("sentinel_detector.worker.Detector", return_value=detector),
    ):
        main()
    assert detector.run_once.call_count == 3
    assert stop.sleeps == [0.25]
    detector.close.assert_called_once()
