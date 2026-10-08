import pytest

from sentinel_detector.rules import load_rules

AUTH, AUTHZ, ADMIN = load_rules()


@pytest.mark.parametrize("rule,threshold", [(AUTH, 5), (AUTHZ, 10), (ADMIN, 3)])
def test_threshold_boundaries(rule, threshold):
    kind = "admin.action" if rule is ADMIN else rule.counted_type
    event = {"type": kind, "action": "change_settings", "outcome": "success"}
    assert rule.reason(event, threshold - 1) is None
    assert rule.reason(event, threshold) is not None


@pytest.mark.parametrize("rule,kind", [(AUTH, "auth.login_failed"), (AUTHZ, "authz.access_denied")])
def test_missing_identity_never_correlates(rule, kind):
    assert rule.correlation({"type": kind}) is None


def test_fallback_and_ipv6_canonicalization():
    assert AUTH.correlation({"type": "auth.login_failed", "actor_id": "actor"}) == (
        "actor",
        "actor",
    )
    assert AUTH.correlation(
        {"type": "auth.login_failed", "actor_id": "actor", "source_ip": "2001:0DB8:0:0:0:0:0:1"}
    ) == ("ip", "2001:db8::1")
    assert AUTHZ.correlation(
        {"type": "authz.access_denied", "actor_id": "actor", "source_ip": "192.0.2.1"}
    ) == ("actor", "actor")
    assert AUTHZ.correlation({"type": "authz.access_denied", "source_ip": "192.0.2.1"}) == (
        "ip",
        "192.0.2.1",
    )


def test_administrative_context_requires_actor_and_sensitive_success():
    assert ADMIN.correlation({"type": "admin.privilege_changed"}) is None
    assert ADMIN.reason({"type": "admin.privilege_changed"}, 0) == "privilege_change"
    for action, outcome in [("create_user", "success"), ("change_settings", "failure")]:
        assert (
            ADMIN.correlation(
                {"type": "admin.action", "actor_id": "actor", "action": action, "outcome": outcome}
            )
            is None
        )
    assert ADMIN.reason({"type": "auth.login_succeeded"}, 3) is None
    assert ADMIN.correlation(
        {
            "type": "admin.action",
            "actor_id": "actor",
            "action": "change_settings",
            "outcome": "success",
        }
    ) == ("actor", "actor")
