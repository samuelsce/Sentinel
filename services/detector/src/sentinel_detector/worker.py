"""M1 worker: verifies contracts/database and idles without consuming any jobs."""

import argparse
import json
import os
import signal
import threading

import psycopg

from sentinel_detector.contracts import load_validator


def database_ready(connection_string: str) -> bool:
    try:
        with psycopg.connect(connection_string, connect_timeout=2) as connection:
            connection.execute("SET statement_timeout = '3s'")
            row = connection.execute("SELECT to_regclass('public.events') IS NOT NULL").fetchone()
            return bool(row and row[0])
    except psycopg.Error:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check readiness once and exit")
    arguments = parser.parse_args()
    connection_string = os.environ.get("DETECTOR_DATABASE_URL")
    if not connection_string:
        raise SystemExit("DETECTOR_DATABASE_URL is required; no credentials were logged.")
    # Schema loading failures are configuration failures, not silently ignored.
    load_validator()
    if arguments.check:
        raise SystemExit(0 if database_ready(connection_string) else 1)

    stop = threading.Event()
    for termination_signal in (signal.SIGTERM, signal.SIGINT):
        signal.signal(termination_signal, lambda _signum, _frame: stop.set())
    previous_status = None
    while not stop.is_set():
        status = "idle" if database_ready(connection_string) else "unavailable"
        if status != previous_status:
            print(
                json.dumps({"service": "detector", "milestone": "M1", "status": status}), flush=True
            )
            previous_status = status
        stop.wait(5)


if __name__ == "__main__":
    main()
