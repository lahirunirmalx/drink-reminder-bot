export const GITHUB_API = 'https://api.github.com';
export const REGISTRY_INDEX_PATH = 'registry/index.json';

export type GitHubApiResult = Record<string, unknown> | Record<string, unknown>[] | null;

export async function githubRequest(
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

export async function githubApi(
  repo: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<GitHubApiResult> {
  return githubRequest(token, method, `/repos/${repo}${path}`, body);
}

export interface RegistryEntry {
  full_name: string;
  name: string;
  created_at: string;
}

export interface RegistryRead {
  entries: RegistryEntry[];
  loaded: boolean;
  sha: string | null;
}

export async function readRegistryIndex(
  repo: string,
  token: string,
  branch: string
): Promise<RegistryRead> {
  const res = await githubApi(
    repo,
    token,
    'GET',
    `/contents/${REGISTRY_INDEX_PATH}?ref=${encodeURIComponent(branch)}`
  );
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return { entries: [], loaded: false, sha: null };
  }
  const obj = res as { content?: string; encoding?: string; sha?: string };
  const sha = typeof obj.sha === 'string' ? obj.sha : null;
  if (!obj.content) return { entries: [], loaded: true, sha };
  const decoded = Buffer.from(obj.content, (obj.encoding as BufferEncoding) || 'base64').toString('utf8');
  if (decoded.trim() === '') return { entries: [], loaded: true, sha };
  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed)) {
      const entries = parsed.filter(
        (e): e is RegistryEntry =>
          e && typeof e === 'object' && typeof e.full_name === 'string' && typeof e.created_at === 'string'
      );
      return { entries, loaded: true, sha };
    }
  } catch (e) {
    console.error('Failed to parse registry/index.json:', e);
  }
  return { entries: [], loaded: true, sha };
}

export async function writeRegistryIndex(
  repo: string,
  token: string,
  branch: string,
  entries: RegistryEntry[],
  message: string,
  sha: string | null
): Promise<boolean> {
  const content = Buffer.from(JSON.stringify(entries, null, 2) + '\n', 'utf8').toString('base64');
  const body: Record<string, unknown> = { message, content, branch };
  if (sha) body.sha = sha;
  const res = await githubApi(repo, token, 'PUT', `/contents/${REGISTRY_INDEX_PATH}`, body);
  return res !== null;
}

export async function deleteRepo(fullName: string, token: string): Promise<boolean> {
  // Direct fetch (not githubRequest) so 404 ("already gone, drop from registry")
  // is distinguishable from real errors; githubRequest collapses all 4xx into null.
  const res = await fetch(`${GITHUB_API}/repos/${fullName}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'daily-commit-netlify',
    },
  });
  if (res.status === 204 || res.status === 404) return true;
  const text = await res.text();
  console.error(`Delete repo ${fullName}: ${res.status} ${text}`);
  return false;
}

export async function runChunked<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
