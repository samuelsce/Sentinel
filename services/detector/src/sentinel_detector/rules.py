"""Versioned deterministic rule semantics; receipt time is the correlation clock."""

import json
from dataclasses import dataclass
from ipaddress import ip_address

from sentinel_detector.contracts import contracts_dir


@dataclass(frozen=True)
class Rule:
    definition: dict

    @property
    def code(self):
        return self.definition["code"]

    @property
    def window(self):
        return self.definition["windowSeconds"]

    @property
    def threshold(self):
        return self.definition["threshold"]

    def correlation(self, event):
        kind = event["type"]
        actor = event.get("actor_id")
        ip = event.get("source_ip")
        if self.code == "AUTH-001" and kind == "auth.login_failed":
            return ("ip", str(ip_address(ip))) if ip else (("actor", actor) if actor else None)
        if self.code == "AUTHZ-001" and kind == "authz.access_denied":
            return ("actor", actor) if actor else (("ip", str(ip_address(ip))) if ip else None)
        if self.code == "ADMIN-001" and actor:
            if kind in ("auth.login_failed", "auth.login_succeeded", "admin.privilege_changed"):
                return ("actor", actor)
            if kind == "admin.action" and event["action"] in self.definition["criticalActions"]:
                if event["outcome"] == "success":
                    return ("actor", actor)
        return None

    def reason(self, event, count):
        if self.code != "ADMIN-001":
            return "threshold" if count >= self.threshold else None
        if event["type"] == "admin.privilege_changed":
            return "privilege_change"
        if event["type"] == "admin.action" and count >= self.threshold:
            return "critical_action_after_failures"
        return None

    @property
    def counted_type(self):
        return "authz.access_denied" if self.code == "AUTHZ-001" else "auth.login_failed"


def load_rules():
    definitions = json.loads(
        (contracts_dir() / "rules/security-rules.v1.json").read_text(encoding="utf-8")
    )
    if [item["code"] for item in definitions] != ["AUTH-001", "AUTHZ-001", "ADMIN-001"]:
        raise ValueError("Unsupported rule definitions")
    return tuple(Rule(item) for item in definitions)
