import type { Pool } from "pg";

// Operator-only maintenance: runtime API/detector roles deliberately have no DELETE grants.
export async function retainProject(
  pool: Pool,
  projectId: string,
  apply = false,
  batch = 500,
) {
  if (
    !/^[0-9a-f-]{36}$/i.test(projectId) ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 1000
  )
    throw new Error("Expected project UUID and batch between 1 and 1000");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='10s'");
    // Same lock as claim: a purge cannot race a worker selecting its next event.
    await client.query("SELECT pg_advisory_xact_lock(73451004)");
    const scope = await client.query<{ organization_id: string }>(
      "SELECT organization_id FROM projects WHERE id=$1 FOR UPDATE",
      [projectId],
    );
    if (!scope.rows[0]) throw new Error("Project not found");
    const removed: Record<string, number> = {};
    const query = async (
      name: string,
      sql: string,
      values: unknown[] = [projectId, batch],
    ) => {
      removed[name] = (await client.query(sql, values)).rowCount ?? 0;
    };
    // A delayed job can still need completed events in its historical detection window.
    const events = (
      await client.query<{ event_id: string }>(
        `SELECT e.event_id FROM events e JOIN detection_jobs j USING(organization_id,project_id,event_id)
       WHERE e.project_id=$1 AND e.received_at<now()-interval '30 days' AND j.status='completed'
       AND NOT EXISTS(SELECT 1 FROM detection_jobs WHERE project_id=$1 AND status IN ('pending','processing'))
       ORDER BY e.received_at,e.ingest_order LIMIT $2 FOR UPDATE OF e,j SKIP LOCKED`,
        [projectId, batch],
      )
    ).rows.map((row) => row.event_id);
    await query(
      "jobs",
      "DELETE FROM detection_jobs WHERE project_id=$1 AND event_id=ANY($2::uuid[])",
      [projectId, events],
    );
    await query(
      "events",
      "DELETE FROM events WHERE project_id=$1 AND event_id=ANY($2::uuid[])",
      [projectId, events],
    );
    const alerts = (
      await client.query<{ id: string }>(
        `SELECT a.id FROM alerts a JOIN detection_episodes ep ON ep.id=a.episode_id
       WHERE a.project_id=$1 AND a.status='resolved' AND a.updated_at<now()-interval '90 days'
         AND ep.last_relevant_at<now()-interval '90 days'
         AND NOT EXISTS(SELECT 1 FROM detection_jobs WHERE project_id=$1 AND status IN ('pending','processing'))
       ORDER BY a.updated_at,a.id LIMIT $2 FOR UPDATE OF a SKIP LOCKED`,
        [projectId, batch],
      )
    ).rows.map((row) => row.id);
    await query(
      "evidence",
      "DELETE FROM alert_evidence WHERE project_id=$1 AND alert_id=ANY($2::uuid[])",
      [projectId, alerts],
    );
    await query(
      "alerts",
      "DELETE FROM alerts WHERE project_id=$1 AND id=ANY($2::uuid[])",
      [projectId, alerts],
    );
    await query(
      "episodes",
      `DELETE FROM detection_episodes WHERE id IN (
      SELECT ep.id FROM detection_episodes ep WHERE ep.project_id=$1 AND ep.last_relevant_at<now()-interval '90 days'
      AND NOT EXISTS(SELECT 1 FROM alerts WHERE episode_id=ep.id)
      AND NOT EXISTS(SELECT 1 FROM detection_jobs WHERE project_id=$1 AND status IN ('pending','processing'))
      ORDER BY ep.last_relevant_at LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    );
    // Audit is organization-wide, so project maintenance never deletes another project's audit.
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { apply, batch, removed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function retainAudit(
  pool: Pool,
  organizationId: string,
  apply = false,
  batch = 500,
) {
  if (
    !/^[0-9a-f-]{36}$/i.test(organizationId) ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 1000
  )
    throw new Error("Expected organization UUID and bounded batch");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='10s'");
    const result = await client.query(
      `DELETE FROM audit_entries WHERE id IN (
      SELECT id FROM audit_entries WHERE organization_id=$1 AND created_at<now()-interval '90 days'
      ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [organizationId, batch],
    );
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { apply, batch, removed: { audit: result.rowCount ?? 0 } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
