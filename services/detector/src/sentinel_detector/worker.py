"""M4 private worker: durable ordered jobs, fenced leases and versioned detections."""

import argparse
import json
import os
import signal
import threading
from uuid import UUID

import psycopg

from sentinel_detector.pipeline import Detector


def database_ready(connection_string: str) -> bool:
    try:
        detector = Detector(connection_string)
        try:
            row = detector.connection.execute(
                """SELECT to_regclass('public.alert_evidence') IS NOT NULL
                   AND EXISTS(SELECT 1 FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='detection_jobs'
                       AND column_name='event_ingest_order') AS ready,
                   (SELECT count(*) FROM detection_jobs WHERE false) AS jobs"""
            ).fetchone()
            return bool(row and row["ready"])
        finally:
            detector.close()
    except (psycopg.Error, ValueError):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check DB/contract/rule readiness")
    parser.add_argument(
        "--drain", action="store_true", help="Process up to 10000 currently ready jobs"
    )
    parser.add_argument(
        "--project", action="append", type=UUID, help="Local operator project filter"
    )
    arguments = parser.parse_args()
    connection_string = os.environ.get("DETECTOR_DATABASE_URL")
    if not connection_string:
        raise SystemExit("DETECTOR_DATABASE_URL is required; no credentials were logged.")
    if arguments.check:
        raise SystemExit(0 if database_ready(connection_string) else 1)

    stop = threading.Event()
    for termination_signal in (signal.SIGTERM, signal.SIGINT):
        signal.signal(termination_signal, lambda _signum, _frame: stop.set())
    detector = None
    previous_status = None
    processed = 0
    try:
        while not stop.is_set():
            worked = False
            try:
                if detector is None:
                    detector = Detector(connection_string, project_ids=arguments.project)
                worked = detector.run_once()
                if worked:
                    processed += 1
                status = "processing" if worked else "idle"
                if arguments.drain and (not worked or processed >= 10000):
                    print(
                        json.dumps(
                            {"service": "detector", "milestone": "M4", "processed": processed}
                        ),
                        flush=True,
                    )
                    break
            except (psycopg.Error, ValueError):
                if detector:
                    detector.close()
                detector = None
                status = "unavailable"
                if arguments.drain:
                    raise SystemExit(
                        "Detector unavailable; no credentials or SQL were logged."
                    ) from None
            if status != previous_status:
                print(
                    json.dumps({"service": "detector", "milestone": "M4", "status": status}),
                    flush=True,
                )
                previous_status = status
            # Poll delay is for an empty queue. Sleeping per completed job capped throughput at 4/s.
            if not worked:
                stop.wait(0.25 if status != "unavailable" else 2)
    finally:
        if detector:
            detector.close()


if __name__ == "__main__":
    main()
