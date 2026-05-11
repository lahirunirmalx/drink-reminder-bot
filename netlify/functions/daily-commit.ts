import { Handler } from '@netlify/functions';

/**
 * Daily commit + side-repo workflow (tuned to fit Netlify's default 10s timeout).
 *
 * Each run:
 *  1. Creates 1..MAX_NEW_REPOS_PER_RUN brand-new repos under GITHUB_TOKEN's
 *     user, in parallel. Repo names use random tech-word combos so they look
 *     organic. For each repo:
 *       - invites GITHUB_APPROVER_TOKEN's user as collaborator (`push`)
 *       - approver auto-accepts the invitation
 *       - commits a realistic-looking file via PR (README/notes/CHANGELOG/TODO)
 *       - approver leaves an APPROVE review
 *       - owner merges the PR
 *       - opens 1..MAX_ISSUES_PER_REPO issues with realistic titles (parallel)
 *  2. On WEEKLY_CLEANUP_WEEKDAY (in TZ): reads the cumulative registry from
 *     the main repo, picks entries older than 2 days, randomly deletes ~half.
 *  3. Commits to GITHUB_REPO in one branch:
 *       - daily/<time>.txt        (existing daily file, unchanged format)
 *       - registry/<time>.json    (per-run audit log)
 *       - registry/index.json     (cumulative repo list for cleanup)
 *     Opens PR to default branch, merges yesterday's still-open PRs.
 *
 * Env:
 *   GITHUB_REPO            owner/repo of the main tracking repo (required)
 *   GITHUB_TOKEN           owner PAT, scopes: repo, delete_repo (required)
 *   GITHUB_APPROVER_TOKEN  separate-bot PAT, scope: repo (optional)
 *   SECRET_KEY             optional auth key (query ?key= or body.key)
 *   TZ                     optional IANA tz (default UTC)
 */

const GITHUB_API = 'https://api.github.com';
const MIN_NEW_REPOS_PER_RUN = 1;
const MAX_NEW_REPOS_PER_RUN = 3;
const MIN_ISSUES_PER_REPO = 1;
const MAX_ISSUES_PER_REPO = 5;
const WEEKLY_CLEANUP_WEEKDAY = 'Sun';
const REPO_AGE_DAYS_BEFORE_DELETE = 2;
const DELETE_PROBABILITY = 0.5;
const REGISTRY_INDEX_PATH = 'registry/index.json';

const TECH_WORDS = [
  'api', 'sdk', 'core', 'util', 'engine', 'parser', 'runner', 'broker',
  'bridge', 'sync', 'queue', 'cache', 'mesh', 'vault', 'gateway', 'registry',
  'kernel', 'proxy', 'agent', 'daemon', 'scheduler', 'dispatcher', 'monitor',
  'tracker', 'listener', 'handler', 'emitter', 'processor', 'validator',
  'adapter', 'loader', 'packer', 'indexer', 'mapper', 'builder', 'compiler',
  'linter', 'fetcher', 'sampler', 'profiler', 'lambda', 'pulse', 'beacon',
  'forge', 'sphere', 'orbit', 'flux', 'pixel', 'nano', 'micro', 'cluster',
  'spool', 'shard', 'pipeline', 'stream', 'buffer', 'router', 'resolver',
  'crawler', 'analyzer', 'gauge', 'rune', 'spark', 'echo', 'helix',
];

const PR_TITLES = [
  'Initial setup', 'Add base config', 'Bootstrap module', 'Wire up scaffolding',
  'Update docs', 'Add readme details', 'Configure defaults', 'Add example config',
  'Tweak settings', 'Refactor structure', 'Tidy up', 'Polish notes',
  'Cleanup formatting', 'Initial commit',
];

const COMMIT_MESSAGES = [
  'Initial setup', 'Bootstrap config', 'Add scaffolding', 'Wire defaults',
  'Update docs', 'Tweak readme', 'Add example', 'Refactor structure',
  'Polish notes', 'Cleanup formatting',
];

const ISSUE_TITLES = [
  'Add unit tests', 'Document API surface', 'Set up CI pipeline',
  'Review caching strategy', 'Optimize startup time', 'Add error handling',
  'Improve logging', 'Add metrics', 'Refactor module structure',
  'Update dependencies', 'Add config validation', 'Improve docs',
  'Add integration tests', 'Profile memory usage', 'Add rate limiting',
  'Investigate flaky test', 'Reduce memory footprint', 'Add health check',
];

const BRANCH_PREFIXES = ['feature', 'update', 'chore', 'fix', 'refactor'];
const BRANCH_TOPICS = ['setup', 'config', 'docs', 'cleanup', 'notes', 'init', 'scaffold'];

const REVIEW_BODIES = ['LGTM', 'Looks good', 'Approved', 'Ship it', ''];

const REPO_DESCRIPTIONS = [
  '', 'Service prototype', 'Personal sandbox', 'Scratch project', 'Side project',
  'WIP module', 'Experimental tooling', 'Internal helper',
];

const README_DESCRIPTIONS = [
  'Personal scratch space.',
  'Service prototype, work in progress.',
  'Experimental module — not yet stable.',
  'Internal tooling, draft.',
  'Side project notes.',
  'Quick prototype for an idea.',
];

type GitHubApiResult = Record<string, unknown> | Record<string, unknown>[] | null;

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDigits(n: number): string {
  const min = Math.pow(10, n - 1);
  const max = Math.pow(10, n) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

function generateRepoName(): string {
  const w1 = pickRandom(TECH_WORDS);
  let w2 = pickRandom(TECH_WORDS);
  while (w2 === w1) w2 = pickRandom(TECH_WORDS);
  return `${w1}-${w2}-${randomDigits(6)}`;
}

function generateBranchName(): string {
  return `${pickRandom(BRANCH_PREFIXES)}/${pickRandom(BRANCH_TOPICS)}-${randomDigits(3)}`;
}

function generateFileChange(repoName: string): { path: string; content: string } {
  const choice = Math.floor(Math.random() * 4);
  switch (choice) {
    case 0:
      return {
        path: 'README.md',
        content: `# ${repoName}\n\n${pickRandom(README_DESCRIPTIONS)}\n`,
      };
    case 1:
      return {
        path: 'notes.md',
        content: `# Notes\n\n${pickRandom(README_DESCRIPTIONS)}\n\n- ${pickRandom(ISSUE_TITLES)}\n- ${pickRandom(ISSUE_TITLES)}\n`,
      };
    case 2:
      return {
        path: 'CHANGELOG.md',
        content: `## Unreleased\n\n- ${pickRandom(COMMIT_MESSAGES)}\n- ${pickRandom(COMMIT_MESSAGES)}\n`,
      };
    default:
      return {
        path: 'TODO.md',
        content: `# TODO\n\n- ${pickRandom(ISSUE_TITLES)}\n- ${pickRandom(ISSUE_TITLES)}\n- ${pickRandom(ISSUE_TITLES)}\n`,
      };
  }
}

async function githubRequest(
  token: string,
  method: string,
  fullPath: string,
  body?: unknown
): Promise<GitHubApiResult> {
  const url = `${GITHUB_API}${fullPath}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'daily-commit-netlify',
  };
  if (body !== undefined && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status >= 400) {
    const text = await res.text();
    console.error(`GitHub API ${method} ${fullPath}: ${res.status} ${text}`);
    return null;
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return {};
  }
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as GitHubApiResult;
  } catch {
    return null;
  }
}

async function githubApi(
  repo: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<GitHubApiResult> {
  return githubRequest(token, method, `/repos/${repo}${path}`, body);
}

async function getDefaultBranchAndLatestCommit(
  repo: string,
  token: string
): Promise<{ branch: string; commitSha: string; treeSha: string } | null> {
  const repoInfo = await githubApi(repo, token, 'GET', '');
  if (!repoInfo || typeof repoInfo !== 'object' || Array.isArray(repoInfo)) return null;
  const defaultBranch = (repoInfo.default_branch as string) || 'main';

  const refRes = await githubApi(repo, token, 'GET', `/git/ref/heads/${defaultBranch}`);
  if (!refRes || typeof refRes !== 'object' || Array.isArray(refRes)) return null;
  const refObj = refRes.object as { sha?: string };
  const commitSha = refObj?.sha;
  if (!commitSha || typeof commitSha !== 'string') return null;

  const commitRes = await githubApi(repo, token, 'GET', `/git/commits/${commitSha}`);
  if (!commitRes || typeof commitRes !== 'object' || Array.isArray(commitRes)) return null;
  const treeObj = (commitRes as { tree?: { sha?: string } }).tree;
  const treeSha = treeObj?.sha;
  if (!treeSha || typeof treeSha !== 'string') return null;

  return { branch: defaultBranch, commitSha, treeSha };
}

async function getBranchCommitAndTree(
  repo: string,
  token: string,
  branch: string
): Promise<{ commitSha: string; treeSha: string } | null> {
  const refRes = await githubApi(repo, token, 'GET', `/git/ref/heads/${branch}`);
  if (!refRes || typeof refRes !== 'object' || Array.isArray(refRes)) return null;
  const commitSha = (refRes.object as { sha?: string })?.sha;
  if (!commitSha) return null;
  const commitRes = await githubApi(repo, token, 'GET', `/git/commits/${commitSha}`);
  if (!commitRes || typeof commitRes !== 'object' || Array.isArray(commitRes)) return null;
  const treeSha = ((commitRes as { tree?: { sha?: string } }).tree)?.sha;
  if (!treeSha) return null;
  return { commitSha, treeSha };
}

interface FileEntry {
  path: string;
  content: string;
}

async function createBranchWithFiles(
  repo: string,
  token: string,
  branchName: string,
  files: FileEntry[],
  commitMessage: string,
  parentSha: string,
  baseTreeSha: string
): Promise<boolean> {
  const blobShas: string[] = [];
  for (const file of files) {
    const blobRes = await githubApi(repo, token, 'POST', '/git/blobs', {
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    if (!blobRes || typeof blobRes !== 'object' || Array.isArray(blobRes)) return false;
    const blobSha = (blobRes as { sha?: string }).sha;
    if (!blobSha) return false;
    blobShas.push(blobSha);
  }
  const treeEntries = files.map((f, i) => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    sha: blobShas[i],
  }));

  const treeRes = await githubApi(repo, token, 'POST', '/git/trees', {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });
  if (!treeRes || typeof treeRes !== 'object' || Array.isArray(treeRes)) return false;
  const newTreeSha = (treeRes as { sha?: string }).sha;
  if (!newTreeSha) return false;

  const commitRes = await githubApi(repo, token, 'POST', '/git/commits', {
    tree: newTreeSha,
    parents: [parentSha],
    message: commitMessage,
  });
  if (!commitRes || typeof commitRes !== 'object' || Array.isArray(commitRes)) return false;
  const newCommitSha = (commitRes as { sha?: string }).sha;
  if (!newCommitSha) return false;

  const refRes = await githubApi(repo, token, 'POST', '/git/refs', {
    ref: `refs/heads/${branchName}`,
    sha: newCommitSha,
  });
  return refRes !== null;
}

async function fetchAllOpenPrs(repo: string, token: string): Promise<Record<string, unknown>[] | null> {
  const all: Record<string, unknown>[] = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const prs = await githubApi(repo, token, 'GET', `/pulls?state=open&per_page=${perPage}&page=${page}`);
    if (!Array.isArray(prs)) return page === 1 ? null : all;
    for (const pr of prs) {
      if (pr && typeof pr === 'object') all.push(pr as Record<string, unknown>);
    }
    if (prs.length < perPage) break;
    page += 1;
  }
  return all;
}

function filterPrsByDate(
  prs: Record<string, unknown>[],
  start: string,
  end: string
): Record<string, unknown>[] {
  const tsStart = new Date(start).getTime();
  const tsEnd = new Date(end).getTime();
  const result: Record<string, unknown>[] = [];
  for (const pr of prs) {
    const created = pr.created_at as string | undefined;
    if (!created) continue;
    const ts = new Date(created).getTime();
    if (ts >= tsStart && ts < tsEnd) result.push(pr);
  }
  return result;
}

interface NewRepo {
  name: string;
  full_name: string;
  default_branch: string;
}

async function createNewRepo(token: string, name: string): Promise<NewRepo | null> {
  const res = await githubRequest(token, 'POST', '/user/repos', {
    name,
    auto_init: true,
    private: false,
    description: pickRandom(REPO_DESCRIPTIONS),
  });
  if (!res || typeof res !== 'object' || Array.isArray(res)) return null;
  const r = res as { full_name?: string; name?: string; default_branch?: string };
  if (!r.full_name || !r.name) return null;
  return { name: r.name, full_name: r.full_name, default_branch: r.default_branch || 'main' };
}

type CollaboratorStatus = 'invited' | 'already' | 'failed' | 'skipped';

async function inviteCollaborator(
  fullName: string,
  ownerToken: string,
  username: string
): Promise<{ status: CollaboratorStatus; invitationId: number | null }> {
  const url = `${GITHUB_API}/repos/${fullName}/collaborators/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ownerToken}`,
      'User-Agent': 'daily-commit-netlify',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ permission: 'push' }),
  });
  if (res.status === 204) return { status: 'already', invitationId: null };
  if (res.status === 201) {
    try {
      const data = (await res.json()) as { id?: number };
      return { status: 'invited', invitationId: typeof data.id === 'number' ? data.id : null };
    } catch {
      return { status: 'invited', invitationId: null };
    }
  }
  const text = await res.text();
  console.error(`Invite collaborator ${username} -> ${fullName}: ${res.status} ${text}`);
  return { status: 'failed', invitationId: null };
}

async function acceptInvitation(approverToken: string, invitationId: number): Promise<boolean> {
  const res = await githubRequest(approverToken, 'PATCH', `/user/repository_invitations/${invitationId}`);
  return res !== null;
}

async function getAuthenticatedUsername(token: string): Promise<string | null> {
  const res = await githubRequest(token, 'GET', '/user');
  if (!res || typeof res !== 'object' || Array.isArray(res)) return null;
  const login = (res as { login?: string }).login;
  return typeof login === 'string' ? login : null;
}

interface Approver {
  token: string;
  username: string;
}

interface RepoActivity {
  name: string;
  full_name: string;
  creation_status: 'created' | 'failed';
  collaborator_status: CollaboratorStatus;
  pr_number: number | null;
  pr_approved: boolean;
  pr_merged: boolean;
  issues: number[];
}

async function runNewRepoWorkflow(
  ownerToken: string,
  approver: Approver | null,
  repo: NewRepo,
  numIssues: number
): Promise<Omit<RepoActivity, 'name' | 'full_name' | 'creation_status'>> {
  let collaboratorStatus: CollaboratorStatus = 'skipped';
  let prNumber: number | null = null;
  let prApproved = false;
  let prMerged = false;
  let issues: number[] = [];

  if (approver) {
    const inv = await inviteCollaborator(repo.full_name, ownerToken, approver.username);
    collaboratorStatus = inv.status;
    if (inv.status === 'invited' && inv.invitationId !== null) {
      await acceptInvitation(approver.token, inv.invitationId);
    }
  }

  const base = await getBranchCommitAndTree(repo.full_name, ownerToken, repo.default_branch);
  if (base) {
    const branchName = generateBranchName();
    const file = generateFileChange(repo.name);
    const commitMessage = pickRandom(COMMIT_MESSAGES);
    const created = await createBranchWithFiles(
      repo.full_name,
      ownerToken,
      branchName,
      [file],
      commitMessage,
      base.commitSha,
      base.treeSha
    );
    if (created) {
      const prTitle = pickRandom(PR_TITLES);
      const prRes = await githubApi(repo.full_name, ownerToken, 'POST', '/pulls', {
        title: prTitle,
        head: branchName,
        base: repo.default_branch,
        body: prTitle,
      });
      if (prRes && typeof prRes === 'object' && !Array.isArray(prRes)) {
        const n = (prRes as { number?: number }).number;
        if (typeof n === 'number') {
          prNumber = n;
          if (approver && collaboratorStatus !== 'failed') {
            const reviewRes = await githubApi(repo.full_name, approver.token, 'POST', `/pulls/${n}/reviews`, {
              event: 'APPROVE',
              body: pickRandom(REVIEW_BODIES),
            });
            prApproved = reviewRes !== null;
          }
          const mergeRes = await githubApi(repo.full_name, ownerToken, 'PUT', `/pulls/${n}/merge`, {
            commit_title: `${prTitle} (#${n})`,
          });
          prMerged = mergeRes !== null;
        }
      }
    }
  }

  const issueResults = await Promise.all(
    Array.from({ length: numIssues }, () =>
      githubApi(repo.full_name, ownerToken, 'POST', '/issues', {
        title: pickRandom(ISSUE_TITLES),
        body: '',
      })
    )
  );
  issues = issueResults
    .map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as { number?: number }).number : null))
    .filter((n): n is number => typeof n === 'number');

  return { collaborator_status: collaboratorStatus, pr_number: prNumber, pr_approved: prApproved, pr_merged: prMerged, issues };
}

interface RegistryEntry {
  full_name: string;
  name: string;
  created_at: string;
}

interface RegistryRead {
  entries: RegistryEntry[];
  loaded: boolean;
}

async function readRegistryIndex(repo: string, token: string, branch: string): Promise<RegistryRead> {
  const res = await githubApi(repo, token, 'GET', `/contents/${REGISTRY_INDEX_PATH}?ref=${encodeURIComponent(branch)}`);
  if (!res || typeof res !== 'object' || Array.isArray(res)) return { entries: [], loaded: false };
  const obj = res as { content?: string; encoding?: string };
  if (!obj.content) return { entries: [], loaded: true };
  const decoded = Buffer.from(obj.content, (obj.encoding as BufferEncoding) || 'base64').toString('utf8');
  if (decoded.trim() === '') return { entries: [], loaded: true };
  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed)) {
      const entries = parsed.filter(
        (e): e is RegistryEntry =>
          e && typeof e === 'object' && typeof e.full_name === 'string' && typeof e.created_at === 'string'
      );
      return { entries, loaded: true };
    }
  } catch (e) {
    console.error('Failed to parse registry/index.json:', e);
  }
  return { entries: [], loaded: true };
}

async function deleteRepo(fullName: string, token: string): Promise<boolean> {
  const res = await githubRequest(token, 'DELETE', `/repos/${fullName}`);
  return res !== null;
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
  const approverTokenRaw = (process.env.GITHUB_APPROVER_TOKEN ?? '').trim();
  if (!repo || !token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GITHUB_REPO and GITHUB_TOKEN must be set' }),
    };
  }

  let tz = (process.env.TZ ?? 'UTC').trim().replace(/^:/, '');
  if (tz === '') tz = 'UTC';
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (id: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === id)?.value ?? '0';
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const branchTime = `${get('year')}-${get('month')}-${get('day')}-${get('hour')}-${get('minute')}-${get('second')}`;
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const weekday = weekdayFormatter.format(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStart = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')} 00:00:00`;
  const yesterdayEnd = `${today} 00:00:00`;

  // Resolve approver up-front (one /user lookup, reused for all repos)
  let approver: Approver | null = null;
  if (approverTokenRaw) {
    const username = await getAuthenticatedUsername(approverTokenRaw);
    if (username) {
      approver = { token: approverTokenRaw, username };
    } else {
      console.error('GITHUB_APPROVER_TOKEN set but /user lookup failed; approvals will be skipped');
    }
  }

  const base = await getDefaultBranchAndLatestCommit(repo, token);
  if (!base) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to get repo default branch or latest commit' }),
    };
  }

  // Load existing cumulative registry (used for cleanup + updated this run)
  const registry = await readRegistryIndex(repo, token, base.branch);

  const epoch = Math.floor(now.getTime() / 1000);
  const random = Math.floor(100000 + Math.random() * 900000);

  // Step A: create N new repos in parallel; each runs its full workflow
  const numNewRepos =
    Math.floor(Math.random() * (MAX_NEW_REPOS_PER_RUN - MIN_NEW_REPOS_PER_RUN + 1)) +
    MIN_NEW_REPOS_PER_RUN;
  const repoActivities: RepoActivity[] = await Promise.all(
    Array.from({ length: numNewRepos }, async (): Promise<RepoActivity> => {
      const repoName = generateRepoName();
      const created = await createNewRepo(token, repoName);
      if (!created) {
        return {
          name: repoName,
          full_name: '',
          creation_status: 'failed',
          collaborator_status: 'skipped',
          pr_number: null,
          pr_approved: false,
          pr_merged: false,
          issues: [],
        };
      }
      const numIssues =
        Math.floor(Math.random() * (MAX_ISSUES_PER_REPO - MIN_ISSUES_PER_REPO + 1)) +
        MIN_ISSUES_PER_REPO;
      const workflow = await runNewRepoWorkflow(token, approver, created, numIssues);
      return {
        name: created.name,
        full_name: created.full_name,
        creation_status: 'created',
        ...workflow,
      };
    })
  );

  // Step B: weekly cleanup of older entries in the registry
  let cleanup: { ran: boolean; checked: number; eligible: number; deleted: string[] } = {
    ran: false,
    checked: 0,
    eligible: 0,
    deleted: [],
  };
  let remainingRegistry = registry.entries;
  if (weekday === WEEKLY_CLEANUP_WEEKDAY) {
    const cutoffMs = now.getTime() - REPO_AGE_DAYS_BEFORE_DELETE * 24 * 60 * 60 * 1000;
    const eligible = registry.entries.filter((e) => new Date(e.created_at).getTime() < cutoffMs);
    const toDelete = eligible.filter(() => Math.random() < DELETE_PROBABILITY);
    const deletions = await Promise.all(
      toDelete.map(async (e) => ((await deleteRepo(e.full_name, token)) ? e.full_name : null))
    );
    const deleted = deletions.filter((n): n is string => n !== null);
    const deletedSet = new Set(deleted);
    remainingRegistry = registry.entries.filter((e) => !deletedSet.has(e.full_name));
    cleanup = { ran: true, checked: registry.entries.length, eligible: eligible.length, deleted };
  }

  // Append today's successfully-created repos to the registry
  const updatedRegistry: RegistryEntry[] = [
    ...remainingRegistry,
    ...repoActivities
      .filter((a) => a.creation_status === 'created' && a.full_name)
      .map((a) => ({ full_name: a.full_name, name: a.name, created_at: now.toISOString() })),
  ];

  // Step C: commit daily file + per-run audit + cumulative registry to main repo, then PR
  const branchName = `daily/${branchTime}`;
  const dailyPath = `daily/${branchTime}.txt`;
  const dailyContent = `${today} ${random} ${epoch}\n`;
  const commitMsg = `Daily commit ${today} ${random}`;
  const auditPath = `registry/${branchTime}.json`;
  const audit = {
    date: today,
    time: branchTime,
    weekday,
    epoch,
    random,
    approver_username: approver?.username ?? null,
    repos: repoActivities,
    weekly_cleanup: cleanup,
  };
  const auditContent = JSON.stringify(audit, null, 2) + '\n';
  const registryContent = JSON.stringify(updatedRegistry, null, 2) + '\n';

  const committed = await createBranchWithFiles(
    repo,
    token,
    branchName,
    [
      { path: dailyPath, content: dailyContent },
      { path: auditPath, content: auditContent },
      { path: REGISTRY_INDEX_PATH, content: registryContent },
    ],
    commitMsg,
    base.commitSha,
    base.treeSha
  );
  if (!committed) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Create branch or commit failed', audit }),
    };
  }

  const prRes = await githubApi(repo, token, 'POST', '/pulls', {
    title: `Daily merge ${today} ${branchTime}`,
    head: branchName,
    base: base.branch,
    body: `Daily run for ${today} ${branchTime}\n\nRepos created: ${repoActivities.length}\nWeekly cleanup ran: ${cleanup.ran}`,
  });
  if (prRes === null) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Create PR failed', audit }),
    };
  }

  // Step D: merge yesterday's still-open PRs
  const openPrs = await fetchAllOpenPrs(repo, token);
  let mergedYesterdayCount = 0;
  if (openPrs !== null) {
    const yesterdayPrs = filterPrsByDate(openPrs, yesterdayStart, yesterdayEnd);
    for (const pr of yesterdayPrs) {
      const num = typeof pr.number === 'number' ? pr.number : 0;
      if (num <= 0) continue;
      await githubApi(repo, token, 'PUT', `/pulls/${num}/merge`, {
        commit_title: `Merge PR #${num}`,
      });
      const head = pr.head as { ref?: string } | undefined;
      const headRef = head?.ref ? String(head.ref).trim() : '';
      if (headRef) {
        const refPath = '/git/refs/heads/' + headRef.split('/').map(encodeURIComponent).join('/');
        await githubApi(repo, token, 'DELETE', refPath);
      }
      mergedYesterdayCount += 1;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      branch: branchName,
      prCreated: true,
      mergedYesterdayCount,
      reposRequested: numNewRepos,
      reposCreated: repoActivities.filter((r) => r.creation_status === 'created').length,
      reposApproved: repoActivities.filter((r) => r.pr_approved).length,
      registrySize: updatedRegistry.length,
      weeklyCleanup: cleanup,
    }),
  };
};
