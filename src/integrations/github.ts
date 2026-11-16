/** Appends coaching rules to docs/BIZOPS_PLAYBOOK.md on GitHub via the Contents API (commit to main triggers a Vercel redeploy). */

export const PLAYBOOK_REPO_PATH = 'docs/BIZOPS_PLAYBOOK.md';
export const LEARNED_HEADING = '## Learned Rules (BizOps Coaching)';
const BRANCH = 'main';

export class GitHubConfigError extends Error {}

function config() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // "owner/name"
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new GitHubConfigError('Teaching is not configured: set GITHUB_TOKEN and GITHUB_REPO (owner/name).');
  }
  return { token, repo };
}

async function gh<T>(token: string, url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`https://api.github.com${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

/** Inserts `bullet` at the end of the Learned Rules section (creating the section at the bottom if absent). */
export function insertLearnedRule(markdown: string, bullet: string): string {
  const text = markdown.replace(/\s+$/, '');
  const i = text.indexOf(LEARNED_HEADING);
  if (i < 0) return `${text}\n\n${LEARNED_HEADING}\n\n${bullet}\n`;
  const next = text.indexOf('\n## ', i + LEARNED_HEADING.length);
  if (next < 0) return `${text}\n${bullet}\n`;
  const section = text.slice(0, next).replace(/\s+$/, '');
  return `${section}\n${bullet}\n${text.slice(next)}\n`;
}

export interface CommitResult {
  commitSha: string;
  commitUrl: string;
}

/** Fetches the playbook's current SHA, appends the rule and commits to main. Retries once on a SHA conflict. */
export async function commitLearnedRule(bullet: string, message: string): Promise<CommitResult> {
  const { token, repo } = config();
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await gh<{ sha?: string; content?: string; message?: string }>(token, `/repos/${repo}/contents/${PLAYBOOK_REPO_PATH}?ref=${BRANCH}`);
    if (cur.status !== 200 || !cur.body.sha || cur.body.content === undefined) {
      throw new Error(`GitHub read failed (${cur.status}): ${cur.body.message ?? 'no content'}`);
    }
    const current = Buffer.from(cur.body.content, 'base64').toString('utf8');
    const updated = insertLearnedRule(current, bullet);
    const put = await gh<{ commit?: { sha: string; html_url: string }; message?: string }>(token, `/repos/${repo}/contents/${PLAYBOOK_REPO_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: Buffer.from(updated, 'utf8').toString('base64'), sha: cur.body.sha, branch: BRANCH }),
    });
    if ((put.status === 200 || put.status === 201) && put.body.commit) {
      return { commitSha: put.body.commit.sha, commitUrl: put.body.commit.html_url };
    }
    // 409: someone committed in between; refetch the SHA and try again.
    if (put.status !== 409 || attempt === 1) throw new Error(`GitHub commit failed (${put.status}): ${put.body.message ?? 'unknown error'}`);
  }
  throw new Error('GitHub commit failed');
}
