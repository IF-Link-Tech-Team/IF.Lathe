/**
 * Pipeline files: one JSON document per repository,
 *
 *   { "repo": "owner/name" | clone URL, "branch": "main", "public": true,
 *     "audit": true, "dormant": false,
 *     "pipelines": [{ "name": "name/check", "vm": true, "on": ["push", "pull_request"],
 *                     "steps": [{ "name": "test", "run": "npm test" }] }] }
 *
 * `dormant` keeps every pipeline of the file manual-only (no push, PR or
 * `after` starts) while another CI still deploys the same app.
 */

export interface PipelineDoc {
  repo: string;
  branch?: string;
  public?: boolean;
  audit?: boolean;
  dormant?: boolean;
  pipelines: any[];
}

/** The clone URL for a file's `repo`: a URL as given, `owner/name` on GitHub over HTTPS. */
export function docRepoUrl(doc: PipelineDoc): string {
  return /^(https?:|git@|file:|\/)/.test(doc.repo) ? doc.repo : `https://github.com/${doc.repo}.git`;
}

/** The pipelines of one file as upsertPipeline input. */
export function pipelinesFromDoc(doc: PipelineDoc, url = docRepoUrl(doc)): { name: string; repo: string; config: Record<string, unknown> }[] {
  const dormant = doc.dormant === true;
  return doc.pipelines.map((p) => ({
    name: p.name,
    repo: url,
    config: {
      repo: url,
      branch: doc.branch,
      vm: p.vm,
      checkout: p.checkout,
      env: p.env ?? {},
      steps: p.steps,
      artifacts: p.artifacts ?? [],
      needs: p.needs ?? [],
      on: dormant ? [] : p.on,
      after: dormant ? undefined : p.after,
      serial: p.serial,
      inputs: p.inputs,
      secrets: p.secrets,
      status: p.status,
      schedule: p.schedule,
      code_scanning: p.code_scanning,
      environment: p.environment,
    },
  }));
}

/** Whether a file turns LLM review on: explicitly, or by running checks on PRs. */
export function docAudits(doc: PipelineDoc): boolean {
  if (doc.audit === false) return false;
  return doc.audit === true || doc.pipelines.some((p) => (p.on ?? []).includes("pull_request"));
}
