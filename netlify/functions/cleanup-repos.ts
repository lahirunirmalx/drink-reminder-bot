import { Handler } from '@netlify/functions';
import {
  readRegistryIndex,
  writeRegistryIndex,
  deleteRepo,
  runChunked,
} from '../../lib/github-registry';

/**
 * Cleanup endpoint — deletes side-repos older than REPO_MAX_AGE_DAYS and
 * removes their entries from registry/index.json.
 *
 * Designed to be invoked aggressively (every few minutes is fine). Uses
 * bounded concurrency to avoid GitHub's secondary rate limit on bursts.
 *
 * Env (same as daily-commit):
 *   GITHUB_REPO   owner/repo of the main tracking repo (required)
 *   GITHUB_TOKEN  owner PAT, scopes: repo, delete_repo (required)
 *   SECRET_KEY    optional auth key (query ?key= or body.key)
 *
 * Query / body overrides (optional):
 *   maxAgeDays    age threshold in days (default REPO_MAX_AGE_DAYS)
 *   maxPerRun     hard cap on deletions per invocation (default MAX_DELETIONS_PER_RUN)
 *   concurrency   parallel DELETEs (default DELETE_CONCURRENCY)
 */

const REPO_MAX_AGE_DAYS = 7;
const MAX_DELETIONS_PER_RUN = 50;
const DELETE_CONCURRENCY = 5;

function readNumericParam(
  event: { queryStringParameters?: Record<string, string | undefined> | null; body?: string | null },
  name: string
): number | null {
  const q = event.queryStringParameters?.[name];
  if (q !== undefined && q !== '' && q !== null) {
    const n = Number(q);
    if (Number.isFinite(n)) return n;
  }
  if (event.body) {
    try {
      const b = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      const v = b?.[name];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secretKey = process.env.SECRET_KEY;
  if (secretKey) {
    const q = event.queryStringParameters?.key ?? '';
    let bodyKey: string | undefined;
    if (event.body) {
      try {
        const b = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        bodyKey = b?.key;
      } catch {
        /* ignore */
      }
    }
    if (q !== secretKey && bodyKey !== secretKey) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  const repo = (process.env.GITHUB_REPO ?? '').trim();
  const token = (process.env.GITHUB_TOKEN ?? '').trim();
  if (!repo || !token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GITHUB_REPO and GITHUB_TOKEN must be set' }),
    };
  }

  const maxAgeDays = readNumericParam(event, 'maxAgeDays') ?? REPO_MAX_AGE_DAYS;
  const maxPerRun = readNumericParam(event, 'maxPerRun') ?? MAX_DELETIONS_PER_RUN;
  const concurrency = readNumericParam(event, 'concurrency') ?? DELETE_CONCURRENCY;

  // Find default branch so the registry read/write target it.
  const repoInfoRes = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'cleanup-repos-netlify',
    },
  });
  if (!repoInfoRes.ok) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to fetch repo info: ${repoInfoRes.status}` }),
    };
  }
  const repoInfo = (await repoInfoRes.json()) as { default_branch?: string };
  const branch = repoInfo.default_branch || 'main';

  const registry = await readRegistryIndex(repo, token, branch);
  if (!registry.loaded) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to read registry/index.json' }),
    };
  }

  const now = Date.now();
  const cutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const allEligible = registry.entries.filter(
    (e) => new Date(e.created_at).getTime() < cutoffMs
  );
  const eligible = allEligible.slice(0, Math.max(0, Math.floor(maxPerRun)));
  const deferred = allEligible.length - eligible.length;

  if (eligible.length === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        registrySize: registry.entries.length,
        eligible: 0,
        deleted: [],
        deferred,
        maxAgeDays,
      }),
    };
  }

  const results = await runChunked(
    eligible,
    async (e) => ((await deleteRepo(e.full_name, token)) ? e.full_name : null),
    Math.max(1, Math.floor(concurrency))
  );
  const deleted = results.filter((n): n is string => n !== null);
  const deletedSet = new Set(deleted);
  const remaining = registry.entries.filter((e) => !deletedSet.has(e.full_name));

  let registryUpdated = false;
  if (deleted.length > 0) {
    registryUpdated = await writeRegistryIndex(
      repo,
      token,
      branch,
      remaining,
      `Cleanup: remove ${deleted.length} repo(s) older than ${maxAgeDays}d`,
      registry.sha
    );
  }

  return {
    statusCode: registryUpdated || deleted.length === 0 ? 200 : 500,
    body: JSON.stringify({
      success: registryUpdated || deleted.length === 0,
      branch,
      registrySize: remaining.length,
      eligible: eligible.length,
      deleted,
      failed: eligible.length - deleted.length,
      deferred,
      registryUpdated,
      maxAgeDays,
      concurrency,
    }),
  };
};
