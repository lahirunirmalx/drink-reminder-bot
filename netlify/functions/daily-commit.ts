import { Handler } from '@netlify/functions';

/**
 * Daily commit: create date branch with file, open PR to main, merge previous day's open PRs.
 * Uses GitHub API only (no git clone). Set GITHUB_REPO (owner/repo) and GITHUB_TOKEN in Netlify env.
 * Trigger via cron or manual POST. Optional: SECRET_KEY in query or body for auth.
 */

const GITHUB_API = 'https://api.github.com';

type GitHubApiResult = Record<string, unknown> | Record<string, unknown>[] | null;

async function githubApi(
  repo: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<GitHubApiResult> {
  const url = `${GITHUB_API}/repos/${repo}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'daily-commit-netlify',
  };
  if (body !== undefined && (method === 'POST' || method === 'PUT')) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status >= 400) {
    const text = await res.text();
    console.error(`GitHub API ${method} ${path}: ${res.status} ${text}`);
    return null;
  }
  if (res.status >= 200 && res.status < 300 && res.headers.get('content-length') === '0') {
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

/** For path "daily/2025-02-13-12-00-00.txt" we need a tree with "daily" dir containing the file. GitHub requires creating the nested tree first. */
async function createBranchWithNestedFile(
  repo: string,
  token: string,
  branchName: string,
  filePath: string,
  fileContent: string,
  commitMessage: string,
  parentSha: string,
  baseTreeSha: string
): Promise<boolean> {
  const blobRes = await githubApi(repo, token, 'POST', '/git/blobs', {
    content: Buffer.from(fileContent, 'utf8').toString('base64'),
    encoding: 'base64',
  });
  if (!blobRes || typeof blobRes !== 'object' || Array.isArray(blobRes)) return false;
  const blobSha = (blobRes as { sha?: string }).sha;
  if (!blobSha) return false;

  const parts = filePath.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1];

  let currentBaseTree = baseTreeSha;
  let dirTreeSha: string | null = null;

  if (parts.length > 1) {
    const dirName = parts[0];
    const subTreeRes = await githubApi(repo, token, 'POST', '/git/trees', {
      tree: [{ path: fileName, mode: '100644', type: 'blob', sha: blobSha }],
    });
    if (!subTreeRes || typeof subTreeRes !== 'object' || Array.isArray(subTreeRes)) return false;
    dirTreeSha = (subTreeRes as { sha?: string }).sha || null;
    if (!dirTreeSha) return false;
    const parentTreeRes = await githubApi(repo, token, 'POST', '/git/trees', {
      base_tree: baseTreeSha,
      tree: [{ path: dirName, mode: '040000', type: 'tree', sha: dirTreeSha }],
    });
    if (!parentTreeRes || typeof parentTreeRes !== 'object' || Array.isArray(parentTreeRes)) return false;
    currentBaseTree = (parentTreeRes as { sha?: string }).sha || currentBaseTree;
  } else {
    const treeRes = await githubApi(repo, token, 'POST', '/git/trees', {
      base_tree: baseTreeSha,
      tree: [{ path: fileName, mode: '100644', type: 'blob', sha: blobSha }],
    });
    if (!treeRes || typeof treeRes !== 'object' || Array.isArray(treeRes)) return false;
    currentBaseTree = (treeRes as { sha?: string }).sha || currentBaseTree;
  }

  const commitRes = await githubApi(repo, token, 'POST', '/git/commits', {
    tree: currentBaseTree,
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
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStart = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')} 00:00:00`;
  const yesterdayEnd = `${today} 00:00:00`;

  const base = await getDefaultBranchAndLatestCommit(repo, token);
  if (!base) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to get repo default branch or latest commit' }),
    };
  }

  const branchName = `daily/${branchTime}`;
  const epoch = Math.floor(now.getTime() / 1000);
  const random = Math.floor(100000 + Math.random() * 900000);
  const filePath = `daily/${branchTime}.txt`;
  const fileContent = `${today} ${random} ${epoch}\n`;
  const commitMsg = `Daily commit ${today} ${random}`;

  const created = await createBranchWithNestedFile(
    repo,
    token,
    branchName,
    filePath,
    fileContent,
    commitMsg,
    base.commitSha,
    base.treeSha
  );
  if (!created) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Create branch or commit failed' }),
    };
  }

  const prRes = await githubApi(repo, token, 'POST', '/pulls', {
    title: `Daily merge ${today} ${branchTime}`,
    head: branchName,
    base: base.branch,
    body: `Auto PR for ${today} ${branchTime}`,
  });
  if (prRes === null) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Create PR failed' }),
    };
  }

  const openPrs = await fetchAllOpenPrs(repo, token);
  if (openPrs === null) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'List PRs failed' }),
    };
  }

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
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      branch: branchName,
      prCreated: true,
      mergedYesterdayCount: yesterdayPrs.length,
    }),
  };
};
