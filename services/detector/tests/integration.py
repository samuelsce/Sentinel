"""Explicit PostgreSQL integration suite; never collected without local test configuration."""

import hashlib
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from sentinel_detector.pipeline import Detector, LeaseLost, iso

owner_url = os.environ.get("TEST_DATABASE_URL", "")
runtime_url = os.environ.get("DETECTOR_DATABASE_URL", "")
if urlparse(owner_url).path != "/sentinel_test" or urlparse(runtime_url).path != "/sentinel_test":
    raise SystemExit("Detector integration requires isolated sentinel_test URLs")
clock = [datetime.now(UTC) + timedelta(seconds=2)]
owner = psycopg.connect(owner_url, autocommit=True, row_factory=dict_row)
orgs = []
projects = []
key_ids = {}
detectors = []
passed = 0


def project(environment="test", org=None):
    if org is None:
        org = uuid4()
        owner.execute("INSERT INTO organizations(id,name) VALUES(%s,'M4 fixture')", (org,))
        orgs.append(org)
    project_id, key_id = uuid4(), uuid4()
    owner.execute(
        "INSERT INTO projects(id,organization_id,name) VALUES(%s,%s,'M4 fixture')",
        (project_id, org),
    )
    owner.execute(
        """INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash)
           VALUES(%s,%s,%s,%s,%s,%s)""",
        (
            key_id,
            org,
            project_id,
            environment,
            f"snt_ing_{key_id}",
            hashlib.sha256(str(key_id).encode()).hexdigest(),
        ),
    )
    projects.append(project_id)
    key_ids[project_id] = (org, key_id, environment)
    return project_id


def add(
    project_id,
    kind="auth.login_failed",
    actor="fixture-actor",
    ip="192.0.2.1",
    at=None,
    action=None,
    payload=None,
    occurred=None,
):
    org, key_id, environment = key_ids[project_id]
    event_id = uuid4()
    at = at or clock[0]
    default_action = {
        "auth.login_failed": "log_in",
        "auth.login_succeeded": "log_in",
        "authz.access_denied": "access_resource",
        "admin.action": "change_settings",
        "admin.privilege_changed": "change_privilege",
    }[kind]
    data = {
        "schema_version": 1,
        "event_id": str(event_id),
        "occurred_at": iso(occurred or at),
        "environment": environment,
        "type": kind,
        "action": action or default_action,
        "outcome": "failure" if kind in ("auth.login_failed", "authz.access_denied") else "success",
        "metadata": {},
    }
    if kind == "admin.privilege_changed":
        data["metadata"] = {
            "target_id": "fixture-target",
            "previous_role": "user",
            "new_role": "admin",
        }
    if actor:
        data["actor_id"] = actor
    if ip:
        data["source_ip"] = ip
    owner.execute(
        """INSERT INTO events(organization_id,project_id,event_id,ingestion_key_id,environment,
           type,actor_id,source_ip,occurred_at,received_at,payload)
           VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            org,
            project_id,
            event_id,
            key_id,
            environment,
            kind,
            actor,
            ip,
            occurred or at,
            at,
            Jsonb(payload or data),
        ),
    )
    owner.execute(
        """INSERT INTO detection_jobs(organization_id,project_id,event_id,available_at)
           VALUES(%s,%s,%s,%s)""",
        (org, project_id, event_id, clock[0] - timedelta(seconds=1)),
    )
    return event_id


def detector(ids):
    result = Detector(runtime_url, now=lambda: clock[0], project_ids=ids)
    detectors.append(result)
    return result


def drain(worker, maximum=600):
    handled = 0
    while worker.run_once():
        handled += 1
        assert handled <= maximum, "Unexpected endless processing"
    return handled


def alerts(project_id, code=None):
    return owner.execute(
        "SELECT * FROM alerts WHERE project_id=%s "
        "AND (rule_code=%s OR %s::text IS NULL) ORDER BY created_at,id",
        (project_id, code, code),
    ).fetchall()


def job(event_id):
    return owner.execute("SELECT * FROM detection_jobs WHERE event_id=%s", (event_id,)).fetchone()


def scenario(name, operation):
    global passed
    operation()
    passed += 1
    print(f"PASS {name}", flush=True)


def thresholds():
    p = project()
    worker = detector([p])
    for _ in range(4):
        add(p)
    drain(worker)
    assert not alerts(p)
    trigger = add(p)
    drain(worker)
    alert = alerts(p, "AUTH-001")[0]
    assert alert["initial_decision"]["count"] == 5
    assert alert["initial_decision"]["triggerEventId"] == str(trigger)
    assert alert["rule_version"] == 1
    for _ in range(9):
        add(p, "authz.access_denied")
    drain(worker)
    assert not alerts(p, "AUTHZ-001")
    add(p, "authz.access_denied")
    drain(worker)
    assert alerts(p, "AUTHZ-001")[0]["initial_decision"]["count"] == 10


def admin_and_benign():
    p = project()
    worker = detector([p])
    add(p, "auth.login_succeeded")
    add(p, "admin.action")
    add(p, "admin.action", action="create_user")
    drain(worker)
    assert not alerts(p)
    for _ in range(2):
        add(p)
    add(p, "admin.action")
    drain(worker)
    assert not alerts(p, "ADMIN-001")
    add(p)
    success = add(p, "auth.login_succeeded")
    add(p, "admin.action")
    drain(worker)
    alert = alerts(p, "ADMIN-001")[0]
    assert alert["initial_decision"]["reason"] == "critical_action_after_failures"
    assert alert["initial_decision"]["count"] == 3
    assert (
        owner.execute(
            "SELECT role FROM alert_evidence WHERE alert_id=%s AND event_id=%s",
            (alert["id"], success),
        ).fetchone()["role"]
        == "context"
    )
    privilege = project()
    add(privilege, "admin.privilege_changed")
    drain(detector([privilege]))
    assert alerts(privilege, "ADMIN-001")[0]["initial_decision"]["threshold"] == 0


def scope_and_identity():
    first = project()
    second = project()
    staging = project("staging", key_ids[first][0])
    for p in (first, second, staging):
        for _ in range(4):
            add(p)
    drain(detector([first, second, staging]))
    assert not any(alerts(p) for p in (first, second, staging))
    add(first)
    drain(detector([first]))
    assert len(alerts(first)) == 1
    assert not alerts(second) and not alerts(staging)
    shared = project()
    original_key = key_ids[shared]
    for _ in range(4):
        add(shared)
    staging_key = uuid4()
    owner.execute(
        "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) "
        "VALUES(%s,%s,%s,'staging',%s,%s)",
        (
            staging_key,
            original_key[0],
            shared,
            f"snt_ing_{staging_key}",
            hashlib.sha256(str(staging_key).encode()).hexdigest(),
        ),
    )
    key_ids[shared] = (original_key[0], staging_key, "staging")
    for _ in range(4):
        add(shared)
    drain(detector([shared]))
    assert not alerts(shared)
    key_ids[shared] = original_key
    add(shared)
    drain(detector([shared]))
    assert len(alerts(shared)) == 1 and alerts(shared)[0]["environment"] == "test"
    unknown = project()
    for _ in range(12):
        add(unknown, actor=None, ip=None)
    drain(detector([unknown]))
    assert not alerts(unknown)
    fallback = project()
    for _ in range(5):
        add(fallback, ip=None)
    drain(detector([fallback]))
    assert len(alerts(fallback, "AUTH-001")) == 1
    v6 = project()
    for i in range(5):
        add(v6, ip="2001:0db8:0:0:0:0:0:1" if i % 2 else "2001:db8::1")
    drain(detector([v6]))
    assert len(alerts(v6, "AUTH-001")) == 1


def windows_and_episodes():
    p = project()
    at = clock[0]
    worker = detector([p])
    for _ in range(4):
        add(p, at=at)
    add(p, at=at + timedelta(seconds=300), occurred=at - timedelta(days=2))
    drain(worker)
    assert len(alerts(p, "AUTH-001")) == 1
    first = alerts(p, "AUTH-001")[0]
    owner.execute("UPDATE alerts SET status='resolved' WHERE id=%s", (first["id"],))
    add(p, at=at + timedelta(seconds=301))
    drain(worker)
    assert len(alerts(p, "AUTH-001")) == 1 and alerts(p)[0]["status"] == "resolved"
    for i in range(5):
        add(p, at=at + timedelta(seconds=602 + i))
    drain(worker)
    assert len(alerts(p, "AUTH-001")) == 2
    expired = project()
    for _ in range(4):
        add(expired, at=at)
    add(expired, at=at + timedelta(seconds=300, microseconds=1))
    drain(detector([expired]))
    assert not alerts(expired)


def rollback_and_retry():
    p = project()
    worker = detector([p])
    for _ in range(4):
        add(p)
    drain(worker)
    last = add(p)
    owner.execute(
        "CREATE FUNCTION m4_fail_evidence() RETURNS trigger LANGUAGE plpgsql "
        "AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$"
    )
    owner.execute(
        "CREATE TRIGGER m4_fail_evidence BEFORE INSERT ON alert_evidence "
        "FOR EACH ROW EXECUTE FUNCTION m4_fail_evidence()"
    )
    try:
        assert worker.run_once()
        assert not alerts(p)
        assert (
            job(last)["status"] == "pending" and job(last)["last_error_code"] == "processing_error"
        )
        assert (
            owner.execute(
                "SELECT total_relevant FROM detection_episodes "
                "WHERE project_id=%s AND rule_code='AUTH-001'",
                (p,),
            ).fetchone()["total_relevant"]
            == 4
        )
    finally:
        owner.execute(
            "DROP TRIGGER m4_fail_evidence ON alert_evidence; DROP FUNCTION m4_fail_evidence()"
        )
    clock[0] += timedelta(seconds=3)
    drain(worker)
    assert len(alerts(p)) == 1 and job(last)["attempts"] == 2
    assert alerts(p)[0]["initial_decision"]["count"] == 5


def crash_and_fencing():
    p = project()
    event_id = add(p)
    owner.execute(
        "UPDATE detection_jobs SET available_at=now()-interval '1 second' WHERE event_id=%s",
        (event_id,),
    )
    child = (
        "from sentinel_detector.pipeline import Detector; import os; from uuid import UUID; "
        "d=Detector(os.environ['DETECTOR_DATABASE_URL'],"
        "project_ids=[UUID(os.environ['M4_CRASH_PROJECT'])]); assert d.claim(); os._exit(0)"
    )
    subprocess.run(
        [sys.executable, "-c", child], env={**os.environ, "M4_CRASH_PROJECT": str(p)}, check=True
    )
    abandoned = job(event_id)
    assert abandoned["status"] == "processing"
    clock[0] = max(clock[0], abandoned["leased_until"]) + timedelta(seconds=1)
    worker = detector([p])
    recovered = worker.claim()
    assert recovered["attempts"] == 2
    try:
        worker.process(abandoned)
    except LeaseLost:
        pass
    else:
        raise AssertionError("Stale lease wrote a job")
    worker.fail(abandoned, permanent=True)
    assert job(event_id)["lease_token"] == recovered["lease_token"]
    worker.process(recovered)
    assert job(event_id)["status"] == "completed"
    try:
        worker.process(recovered)
    except LeaseLost:
        pass
    else:
        raise AssertionError("Completed job was processed twice")


def expiry_during_commit():
    p = project()
    worker = detector([p])
    for _ in range(4):
        add(p)
    drain(worker)
    last = add(p)
    claim = worker.claim()
    original = worker.detect

    def expiring(*args):
        original(*args)
        clock[0] += timedelta(seconds=31)

    worker.detect = expiring
    try:
        worker.process(claim)
    except LeaseLost:
        pass
    else:
        raise AssertionError("Expired lease committed results")
    assert not alerts(p)
    worker.detect = original
    drain(worker)
    assert len(alerts(p)) == 1 and job(last)["attempts"] == 2


def poison_and_exhaustion():
    p = project()
    invalid = add(p, payload={"password": "must-not-log"})
    worker = detector([p])
    drain(worker)
    assert job(invalid)["status"] == "failed" and job(invalid)["last_error_code"] == "invalid_event"
    broken = add(p)
    original = worker.process

    def fail(_job):
        raise RuntimeError("password=must-not-log")

    worker.process = fail
    for attempt in range(1, 6):
        assert worker.run_once()
        assert job(broken)["attempts"] == attempt
        clock[0] = job(broken)["available_at"] + timedelta(microseconds=1)
    assert job(broken)["status"] == "failed"
    worker.process = original
    exhausted = add(p)
    claim = worker.claim()
    owner.execute(
        "UPDATE detection_jobs SET attempts=5,leased_until=%s WHERE id=%s",
        (clock[0] - timedelta(seconds=1), claim["id"]),
    )
    assert worker.run_once() and job(exhausted)["last_error_code"] == "lease_exhausted"
    last = add(p)
    drain(worker)
    assert job(last)["status"] == "completed"


def project_ordering_and_parallel_claims():
    first, second = project(), project()
    head = add(first)
    later = add(first)
    other = add(second)
    worker = detector([first, second])
    parallel = detector([first, second])
    claim = worker.claim()
    assert claim["event_id"] == head
    concurrent = parallel.claim()
    assert concurrent["event_id"] == other
    assert parallel.claim() is None
    parallel.process(concurrent)
    worker.fail(claim)
    assert worker.claim() is None
    clock[0] += timedelta(seconds=3)
    drain(worker)
    assert job(later)["status"] == "completed"


def bounded_evidence_and_privileges():
    p = project()
    for _ in range(210):
        add(p)
    worker = detector([p])
    drain(worker)
    alert = alerts(p, "AUTH-001")[0]
    assert alert["peak_count"] == 210 and alert["evidence_truncated"]
    assert (
        owner.execute(
            "SELECT count(*) AS count FROM alert_evidence WHERE alert_id=%s", (alert["id"],)
        ).fetchone()["count"]
        == 200
    )
    for sql in [
        "SELECT * FROM users",
        "SELECT * FROM sessions",
        "UPDATE alerts SET status='resolved'",
        "UPDATE rule_definitions SET definition='{}'::jsonb",
    ]:
        try:
            worker.connection.execute(sql)
        except psycopg.errors.InsufficientPrivilege:
            pass
        else:
            raise AssertionError("Detector exceeded its privileges")


try:
    for name, operation in [
        ("rule thresholds and receipt ordering", thresholds),
        ("benign admin activity, context evidence and privilege change", admin_and_benign),
        ("project/environment scope, identity fallback and canonical IPv6", scope_and_identity),
        ("inclusive windows, silence episodes and resolved status", windows_and_episodes),
        ("atomic SQL failure and retry without inflated counts", rollback_and_retry),
        ("abrupt worker exit, recovered claim and stale lease fencing", crash_and_fencing),
        ("lease expiry before completion rolls back result writes", expiry_during_commit),
        ("poison jobs, bounded retries and expired attempt exhaustion", poison_and_exhaustion),
        (
            "per-project order, delayed head and concurrent claimers",
            project_ordering_and_parallel_claims,
        ),
        ("bounded evidence and least-privilege detector role", bounded_evidence_and_privileges),
    ]:
        scenario(name, operation)
    print(f"Detector integration: {passed} scenarios passed.", flush=True)
finally:
    for worker in detectors:
        worker.close()
    for table in [
        "alert_evidence",
        "alerts",
        "detection_episodes",
        "detection_jobs",
        "events",
        "ingestion_quotas",
        "ingestion_keys",
    ]:
        owner.execute(f"DELETE FROM {table} WHERE project_id=ANY(%s)", (projects,))
    owner.execute("DELETE FROM projects WHERE id=ANY(%s)", (projects,))
    owner.execute("DELETE FROM organizations WHERE id=ANY(%s)", (orgs,))
    owner.close()
