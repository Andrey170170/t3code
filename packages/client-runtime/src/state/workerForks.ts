import type { EnvironmentThreadShell } from "./models.ts";

/**
 * Projects that are Trellis worker forks as clients can tell from threads
 * alone: no active lead there, and a delegated worker whose lead works in
 * another project (only a fork spawn puts a worker outside its lead's
 * project). Clients keep them out of project lists; a lead started there
 * shows the project again. Keys are `<environmentId>:<projectId>`.
 */
export function workerForkProjectKeys(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "archivedAt" | "lineage">
  >,
): ReadonlySet<string> {
  const projectOf = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.projectId]),
  );
  const withLead = new Set<string>();
  const withForkWorker = new Set<string>();
  for (const thread of threads) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    if (thread.lineage.relationshipToParent !== "subagent") {
      if (thread.archivedAt === null) withLead.add(key);
      continue;
    }
    const parent = thread.lineage.parentThreadId;
    const leadProject =
      parent === null ? undefined : projectOf.get(`${thread.environmentId}:${parent}`);
    if (leadProject !== undefined && leadProject !== thread.projectId) withForkWorker.add(key);
  }
  return new Set([...withForkWorker].filter((key) => !withLead.has(key)));
}
