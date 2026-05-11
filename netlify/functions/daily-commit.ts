import { Handler } from '@netlify/functions';

/**
 * Daily commit + auto-repo workflow (tuned to fit Netlify's default 10s timeout).
 *
 * Each run:
 *  1. Creates 1..MAX_AUTO_REPOS brand-new repos under GITHUB_TOKEN's user
 *     (prefix `auto-daily-`), in parallel. For each repo:
 *       - invites GITHUB_APPROVER_TOKEN's user as collaborator (`push`)
 *       - approver auto-accepts the invitation
 *       - pushes a file via PR
 *       - approver leaves an APPROVE review
 *       - owner merges the PR
 *       - opens 1..MAX_ISSUES_PER_REPO issues (parallel)
 *     If GITHUB_APPROVER_TOKEN is missing, collaborator + approve steps are
 *     skipped (the PR still merges).
 *  2. On weekday WEEKLY_CLEANUP_WEEKDAY (in TZ): lists `auto-daily-` repos
 *     >2 days old and randomly deletes ~half.
 *  3. Commits `daily/<time>.txt` (unchanged) + `registry/<time>.json` (audit
 *     log with repo names, PR numbers, approval/merge status, issues, cleanup
 *     results) to GITHUB_REPO in one branch, opens PR, merges yesterday's
 *     still-open PRs.
 *
 * Env:
 *   GITHUB_REPO            owner/repo of the main tracking repo (required)
 *   GITHUB_TOKEN           owner PAT, scopes: repo, delete_repo (required)
 *   GITHUB_APPROVER_TOKEN  separate-bot PAT, scope: repo (optional). When set,
 *                          PRs in auto repos receive a real APPROVE review.
 *   SECRET_KEY             optional auth key (query ?key= or body.key)
 *   TZ                     optional IANA tz (default UTC)
 *
 * Sizing: MAX_AUTO_REPOS = 3 keeps total runtime well under 10s with parallel
 * workflows. Raise it only if you switch the file to a Netlify Background
 * Function (rename to `daily-commit-background.ts`, 15min limit).
 */

const GITHUB_API = 'https://api.github.com';
const AUTO_REPO_PREFIX = 'auto-daily-';
const MIN_AUTO_REPOS = 1;
const MAX_AUTO_REPOS = 3;
const MIN_ISSUES_PER_REPO = 1;
const MAX_ISSUES_PER_REPO = 5;
const WEEKLY_CLEANUP_WEEKDAY = 'Sun';
const REPO_AGE_DAYS_BEFORE_DELETE = 2;
const DELETE_PROBABILITY = 0.5;

type GitHubApiResult = Record<string, unknown> | Record<string, unknown>[] | null;

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

interface AutoRepoCreation {
  name: string;
  full_name: string;
  default_branch: string;
}

async function createAutoRepo(token: string, name: string, today: string): Promise<AutoRepoCreation | null> {
  const res = await githubRequest(token, 'POST', '/user/repos', {
    name,
    auto_init: true,
    private: false,
    description: `Auto-created on ${today}`,
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

async function runAutoRepoWorkflow(
  ownerToken: string,
  approver: Approver | null,
  fullName: string,
  defaultBranch: string,
  branchName: string,
  fileContent: string,
  numIssues: number
): Promise<Omit<RepoActivity, 'name' | 'full_name' | 'creation_status'>> {
  let collaboratorStatus: CollaboratorStatus = 'skipped';
  let prNumber: number | null = null;
  let prApproved = false;
  let prMerged = false;
  let issues: number[] = [];

  if (approver) {
    const inv = await inviteCollaborator(fullName, ownerToken, approver.username);
    collaboratorStatus = inv.status;
    if (inv.status === 'invited' && inv.invitationId !== null) {
      await acceptInvitation(approver.token, inv.invitationId);
    }
  }

  const base = await getBranchCommitAndTree(fullName, ownerToken, defaultBranch);
  if (base) {
    const created = await createBranchWithFiles(
      fullName,
      ownerToken,
      branchName,
      [{ path: 'auto-update.txt', content: fileContent }],
      'Auto update',
      base.commitSha,
      base.treeSha
    );
    if (created) {
      const prRes = await githubApi(fullName, ownerToken, 'POST', '/pulls', {
        title: 'Auto PR',
        head: branchName,
        base: defaultBranch,
        body: 'Auto-generated PR from daily-commit function',
      });
      if (prRes && typeof prRes === 'object' && !Array.isArray(prRes)) {
        const n = (prRes as { number?: number }).number;
        if (typeof n === 'number') {
          prNumber = n;
          if (approver && collaboratorStatus !== 'failed') {
            const reviewRes = await githubApi(fullName, approver.token, 'POST', `/pulls/${n}/reviews`, {
              event: 'APPROVE',
              body: 'Auto-approved',
            });
            prApproved = reviewRes !== null;
          }
          const mergeRes = await githubApi(fullName, ownerToken, 'PUT', `/pulls/${n}/merge`, {
            commit_title: `Auto merge PR #${n}`,
          });
          prMerged = mergeRes !== null;
        }
      }
    }
  }

  const issueResults = await Promise.all(
    Array.from({ length: numIssues }, (_, i) =>
      githubApi(fullName, ownerToken, 'POST', '/issues', {
        title: `Auto task #${i + 1}`,
        body: `Auto-generated issue ${i + 1} of ${numIssues}.`,
      })
    )
  );
  issues = issueResults
    .map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as { number?: number }).number : null))
    .filter((n): n is number => typeof n === 'number');

  return { collaborator_status: collaboratorStatus, pr_number: prNumber, pr_approved: prApproved, pr_merged: prMerged, issues };
}

interface AutoRepoInfo {
  full_name: string;
  name: string;
  created_at: string;
}

async function listOwnedAutoRepos(token: string, prefix: string): Promise<AutoRepoInfo[]> {
  const all: AutoRepoInfo[] = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const res = await githubRequest(
      token,
      'GET',
      `/user/repos?per_page=${perPage}&page=${page}&affiliation=owner&sort=created&direction=asc`
    );
    if (!Array.isArray(res)) break;
    for (const r of res) {
      if (!r || typeof r !== 'object') continue;
      const obj = r as { name?: string; full_name?: string; created_at?: string };
      if (
        typeof obj.name === 'string' &&
        typeof obj.full_name === 'string' &&
        typeof obj.created_at === 'string' &&
        obj.name.startsWith(prefix)
      ) {
        all.push({ name: obj.name, full_name: obj.full_name, created_at: obj.created_at });
      }
    }
    if (res.length < perPage) break;
    page += 1;
  }
  return all;
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

  const epoch = Math.floor(now.getTime() / 1000);
  const random = Math.floor(100000 + Math.random() * 900000);

  // Step A: create random N auto repos in parallel; each runs its full workflow
  const numAutoRepos =
    Math.floor(Math.random() * (MAX_AUTO_REPOS - MIN_AUTO_REPOS + 1)) + MIN_AUTO_REPOS;
  const autoRepoActivities: RepoActivity[] = await Promise.all(
    Array.from({ length: numAutoRepos }, async (): Promise<RepoActivity> => {
      const suffix = `${branchTime}-${Math.floor(100000 + Math.random() * 900000)}`;
      const repoName = `${AUTO_REPO_PREFIX}${suffix}`;
      const created = await createAutoRepo(token, repoName, today);
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
      const workflow = await runAutoRepoWorkflow(
        token,
        approver,
        created.full_name,
        created.default_branch,
        `auto/${branchTime}`,
        `Auto-generated by daily-commit ${today} ${random}\n`,
        numIssues
      );
      return {
        name: created.name,
        full_name: created.full_name,
        creation_status: 'created',
        ...workflow,
      };
    })
  );

  // Step B: weekly cleanup of older auto repos
  let cleanup: { ran: boolean; checked: number; eligible: number; deleted: string[] } = {
    ran: false,
    checked: 0,
    eligible: 0,
    deleted: [],
  };
  if (weekday === WEEKLY_CLEANUP_WEEKDAY) {
    const ownedAutos = await listOwnedAutoRepos(token, AUTO_REPO_PREFIX);
    const cutoffMs = now.getTime() - REPO_AGE_DAYS_BEFORE_DELETE * 24 * 60 * 60 * 1000;
    const eligible = ownedAutos.filter((r) => new Date(r.created_at).getTime() < cutoffMs);
    const toDelete = eligible.filter(() => Math.random() < DELETE_PROBABILITY);
    const deletions = await Promise.all(
      toDelete.map(async (r) => ((await deleteRepo(r.full_name, token)) ? r.full_name : null))
    );
    const deleted = deletions.filter((n): n is string => n !== null);
    cleanup = { ran: true, checked: ownedAutos.length, eligible: eligible.length, deleted };
  }

  // Step C: commit daily file + tracking registry to main repo, then PR
  const branchName = `daily/${branchTime}`;
  const filePath = `daily/${branchTime}.txt`;
  const fileContent = `${today} ${random} ${epoch}\n`;
  const commitMsg = `Daily commit ${today} ${random}`;
  const trackingPath = `registry/${branchTime}.json`;
  const tracking = {
    date: today,
    time: branchTime,
    weekday,
    epoch,
    random,
    approver_username: approver?.username ?? null,
    auto_repos: autoRepoActivities,
    weekly_cleanup: cleanup,
  };
  const trackingContent = JSON.stringify(tracking, null, 2) + '\n';

  const committed = await createBranchWithFiles(
    repo,
    token,
    branchName,
    [
      { path: filePath, content: fileContent },
      { path: trackingPath, content: trackingContent },
    ],
    commitMsg,
    base.commitSha,
    base.treeSha
  );
  if (!committed) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Create branch or commit failed', tracking }),
    };
  }

  const prRes = await githubApi(repo, token, 'POST', '/pulls', {
    title: `Daily merge ${today} ${branchTime}`,
    head: branchName,
    base: base.branch,
    body: `Auto PR for ${today} ${branchTime}\n\nAuto repos created: ${autoRepoActivities.length}\nWeekly cleanup ran: ${cleanup.ran}`,
  });
  if (prRes === null) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Create PR failed', tracking }),
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
      autoReposRequested: numAutoRepos,
      autoReposCreated: autoRepoActivities.filter((r) => r.creation_status === 'created').length,
      autoReposApproved: autoRepoActivities.filter((r) => r.pr_approved).length,
      weeklyCleanup: cleanup,
    }),
  };
};
