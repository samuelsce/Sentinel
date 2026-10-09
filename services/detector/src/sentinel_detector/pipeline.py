"""Durable claims, fenced transactions and bounded evidence for the M4 worker."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from sentinel_detector.contracts import load_validator
from sentinel_detector.rules import Rule, load_rules

MAX_ATTEMPTS = 5
LEASE_SECONDS = 30
MAX_EVIDENCE = 200


class LeaseLost(Exception):
    pass


class InvalidEvent(Exception):
    pass


class Detector:
    def __init__(self, connection_string, now=None, project_ids=None):
        self.validator = load_validator()
        self.rules = load_rules()
        self.connection = psycopg.connect(
            connection_string,
            autocommit=True,
            connect_timeout=2,
            row_factory=dict_row,
            options="-c statement_timeout=3000 -c timezone=UTC",
        )
        self.now = now or (lambda: datetime.now(UTC))
        self.project_ids = project_ids
        try:
            stored = self.connection.execute(
                "SELECT code,version,definition FROM rule_definitions WHERE version=1"
            ).fetchall()
            for rule in self.rules:
                if not any(
                    row["code"] == rule.code
                    and row["version"] == rule.definition["version"]
                    and row["definition"] == rule.definition
                    for row in stored
                ):
                    raise ValueError("Rule definition/version mismatch")
        except Exception:
            self.close()
            raise

    def close(self):
        self.connection.close()

    def claim(self):
        now = self.now()
        with self.connection.transaction():
            # Serializes the brief selection step across claimers. No long-lived global lock.
            self.connection.execute("SELECT pg_advisory_xact_lock(73451004)")
            job = self.connection.execute(
                """SELECT j.* FROM projects p
                   CROSS JOIN LATERAL (
                     SELECT h.id FROM detection_jobs h WHERE h.project_id=p.id
                       AND h.status IN ('pending','processing')
                     ORDER BY h.event_received_at,h.event_ingest_order LIMIT 1
                   ) head JOIN detection_jobs j ON j.id=head.id
                   WHERE (p.id=ANY(%s::uuid[]) OR %s::uuid[] IS NULL)
                     AND ((j.status='pending' AND j.available_at<=%s)
                       OR (j.status='processing' AND j.leased_until<=%s))
                     AND NOT EXISTS(SELECT 1 FROM detection_jobs running
                       WHERE running.project_id=j.project_id AND running.id<>j.id
                         AND running.status='processing' AND running.leased_until>%s)
                   ORDER BY j.event_received_at,j.event_ingest_order
                   FOR UPDATE OF j SKIP LOCKED LIMIT 1""",
                (self.project_ids, self.project_ids, now, now, now),
            ).fetchone()
            if not job:
                return None
            if job["attempts"] >= MAX_ATTEMPTS:
                self.connection.execute(
                    """UPDATE detection_jobs SET status='failed',lease_token=NULL,
                       leased_until=NULL,last_error_code='lease_exhausted' WHERE id=%s""",
                    (job["id"],),
                )
                return {"exhausted": True}
            token = uuid4()
            return self.connection.execute(
                """UPDATE detection_jobs SET status='processing',attempts=attempts+1,
                   lease_token=%s,leased_until=%s,last_error_code=NULL WHERE id=%s RETURNING *""",
                (token, now + timedelta(seconds=LEASE_SECONDS), job["id"]),
            ).fetchone()

    def process(self, job):
        with self.connection.transaction():
            owned = self.connection.execute(
                """SELECT j.id,j.rule_snapshot,e.* FROM detection_jobs j JOIN events e
                   ON (e.organization_id,e.project_id,e.event_id)=
                      (j.organization_id,j.project_id,j.event_id)
                   WHERE j.id=%s AND j.status='processing' AND j.lease_token=%s
                     AND j.leased_until>%s FOR UPDATE OF j""",
                (job["id"], job["lease_token"], self.now()),
            ).fetchone()
            if not owned:
                raise LeaseLost()
            event = owned["payload"]
            if not self.validator.is_valid(event):
                raise InvalidEvent()
            if (
                event["event_id"].lower() != str(owned["event_id"])
                or event["environment"] != owned["environment"]
                or event["type"] != owned["type"]
                or event.get("actor_id") != owned["actor_id"]
                or event.get("source_ip") != owned["source_ip"]
            ):
                raise InvalidEvent()
            effective = self.rules
            if owned["rule_snapshot"] is not None:
                effective = []
                for selection in owned["rule_snapshot"]:
                    if not selection["enabled"]:
                        continue
                    definition = self.connection.execute(
                        "SELECT definition FROM rule_definitions WHERE code=%s AND version=%s",
                        (selection["code"], selection["version"]),
                    ).fetchone()
                    if not definition:
                        raise InvalidEvent()
                    effective.append(Rule(definition["definition"]))
            for rule in effective:
                correlation = rule.correlation(event)
                if correlation:
                    self.detect(rule, owned, correlation)
            completed = self.connection.execute(
                """UPDATE detection_jobs SET status='completed',completed_at=clock_timestamp(),
                   lease_token=NULL,
                   leased_until=NULL,last_error_code=NULL WHERE id=%s AND lease_token=%s
                   AND status='processing' AND leased_until>%s RETURNING id""",
                (job["id"], job["lease_token"], self.now()),
            ).fetchone()
            if not completed:
                raise LeaseLost()

    def fail(self, job, permanent=False):
        code = "invalid_event" if permanent else "processing_error"
        state = "failed" if permanent or job["attempts"] >= MAX_ATTEMPTS else "pending"
        self.connection.execute(
            """UPDATE detection_jobs SET status=%s,last_error_code=%s,lease_token=NULL,
               leased_until=NULL,available_at=%s WHERE id=%s AND lease_token=%s
               AND status='processing' AND leased_until>%s""",
            (
                state,
                code,
                self.now() + timedelta(seconds=min(2 ** job["attempts"], 60)),
                job["id"],
                job["lease_token"],
                self.now(),
            ),
        )

    def run_once(self):
        job = self.claim()
        if not job:
            return False
        if job.get("exhausted"):
            return True
        try:
            self.process(job)
        except LeaseLost:
            pass  # Another lease owns the job: no state/result may be overwritten.
        except InvalidEvent:
            self.fail(job, permanent=True)
        except Exception:
            # SQL messages/payloads/credentials are never persisted or logged.
            self.fail(job)
        return True

    def detect(self, rule, row, correlation):
        kind, value = correlation
        key = (
            row["organization_id"],
            row["project_id"],
            row["environment"],
            rule.code,
            rule.definition["version"],
            kind,
            value,
        )
        episode = self.connection.execute(
            """SELECT * FROM detection_episodes WHERE organization_id=%s AND project_id=%s
               AND environment=%s AND rule_code=%s AND rule_version=%s
               AND correlation_kind=%s AND correlation_value=%s AND ended_at IS NULL FOR UPDATE""",
            key,
        ).fetchone()
        at = row["received_at"]
        window = timedelta(seconds=rule.window)
        if episode and at - episode["last_relevant_at"] > window:
            self.connection.execute(
                "UPDATE detection_episodes SET ended_at=%s WHERE id=%s",
                (episode["last_relevant_at"] + window, episode["id"]),
            )
            episode = None
        if not episode:
            episode = self.connection.execute(
                """INSERT INTO detection_episodes(organization_id,project_id,environment,
                   rule_code,rule_version,correlation_kind,correlation_value,started_at,
                   last_relevant_at,total_relevant) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,0)
                   RETURNING *""",
                (*key, at, at),
            ).fetchone()
        self.connection.execute(
            """UPDATE detection_episodes SET last_relevant_at=GREATEST(last_relevant_at,%s),
               total_relevant=total_relevant+1 WHERE id=%s""",
            (at, episode["id"]),
        )
        predicate = "e.source_ip::inet=%s::inet" if kind == "ip" else "e.actor_id=%s"
        if rule.code == "AUTH-001" and kind == "actor":
            predicate += " AND e.source_ip IS NULL"
        if rule.code == "AUTHZ-001" and kind == "ip":
            predicate += " AND e.actor_id IS NULL"
        types = [rule.counted_type]
        if rule.code == "ADMIN-001":
            types += ["auth.login_succeeded", "admin.action", "admin.privilege_changed"]
            predicate += (
                " AND (e.type<>'admin.action' OR (e.payload->>'action'=ANY(%s)"
                " AND e.payload->>'outcome'='success'))"
            )
        parameters = (
            row["project_id"],
            row["environment"],
            max(at - window, episode["started_at"]),
            at,
            row["ingest_order"],
            row["event_id"],
            types,
            value,
        )
        if rule.code == "ADMIN-001":
            parameters += (rule.definition["criticalActions"],)
        query = f"""FROM events e JOIN detection_jobs j
                    ON (e.organization_id,e.project_id,e.event_id)=
                       (j.organization_id,j.project_id,j.event_id)
                    WHERE e.project_id=%s AND e.environment=%s AND e.received_at>=%s
                      AND (e.received_at,e.ingest_order)<=(%s,%s)
                      AND (j.status='completed' OR e.event_id=%s)
                      AND e.type::text=ANY(%s) AND {predicate}"""
        count = self.connection.execute(
            f"SELECT count(*) FILTER(WHERE e.type::text=%s) AS count {query}",
            (rule.counted_type, *parameters),
        ).fetchone()["count"]
        reason = rule.reason(row["payload"], count)
        alert = self.connection.execute(
            "SELECT * FROM alerts WHERE episode_id=%s FOR UPDATE",
            (episode["id"],),
        ).fetchone()
        if not alert and not reason:
            return
        decision = {
            "timeBasis": "received_at",
            "windowSeconds": rule.window,
            "threshold": 0 if reason == "privilege_change" else rule.threshold,
            "windowStart": iso(max(at - window, episode["started_at"])),
            "windowEnd": iso(at),
            "count": count,
            "triggerEventId": str(row["event_id"]),
            "reason": reason,
        }
        if not alert:
            alert = self.connection.execute(
                """INSERT INTO alerts(organization_id,project_id,environment,episode_id,
                   rule_code,rule_version,severity,initial_decision,last_decision,peak_count)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (
                    row["organization_id"],
                    row["project_id"],
                    row["environment"],
                    episode["id"],
                    rule.code,
                    rule.definition["version"],
                    rule.definition["severity"],
                    Jsonb(decision),
                    Jsonb(decision),
                    count,
                ),
            ).fetchone()
        else:
            self.connection.execute(
                """UPDATE alerts SET last_decision=%s,peak_count=GREATEST(peak_count,%s),
                   updated_at=%s WHERE id=%s""",
                (
                    Jsonb(decision if reason else alert["last_decision"]),
                    count,
                    self.now(),
                    alert["id"],
                ),
            )
        evidence = self.connection.execute(
            f"SELECT e.event_id,e.type {query} ORDER BY e.received_at,e.ingest_order LIMIT 201",
            parameters,
        ).fetchall()
        # Prioritize the original trigger; evidence is capped per episode, not per request.
        candidates = [{"event_id": row["event_id"], "type": row["type"]}, *evidence]
        stored = {
            item["event_id"]
            for item in self.connection.execute(
                "SELECT event_id FROM alert_evidence WHERE alert_id=%s",
                (alert["id"],),
            ).fetchall()
        }
        truncated = len(evidence) > MAX_EVIDENCE
        for item in candidates:
            if item["event_id"] in stored:
                continue
            if len(stored) >= MAX_EVIDENCE:
                truncated = True
                continue
            role = (
                "trigger"
                if item["event_id"] == row["event_id"] and reason
                else ("context" if item["type"] == "auth.login_succeeded" else "support")
            )
            self.connection.execute(
                """INSERT INTO alert_evidence(organization_id,project_id,environment,
                   alert_id,event_id,role)
                   VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (
                    row["organization_id"],
                    row["project_id"],
                    row["environment"],
                    alert["id"],
                    item["event_id"],
                    role,
                ),
            )
            stored.add(item["event_id"])
        if truncated:
            self.connection.execute(
                "UPDATE alerts SET evidence_truncated=true WHERE id=%s", (alert["id"],)
            )


def iso(value):
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
