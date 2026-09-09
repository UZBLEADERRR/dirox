/**
 * Pushing a finished project to GitHub.
 *
 * api.github.com allows browser requests, so this needs no server of its own:
 * the user's token stays on their device and the commit is assembled here —
 * blobs, a tree, a commit, a ref — which puts the whole project in one commit
 * rather than a flurry of file-by-file writes.
 */

import { state } from './store.js';

const API = 'https://api.github.com';

export const hasGithub = () => !!state.settings.githubToken;

async function gh(path, { method = 'GET', body, token = state.settings.githubToken } = {}) {
  if (!token) throw new Error('No GitHub token. Add one in Settings.');
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? 'GitHub rejected the token.' : detail);
  }
  return data;
}

export const whoami = () => gh('/user');

/** Finds the repository, or makes it. */
async function ensureRepo(owner, name, isPrivate) {
  try { return await gh(`/repos/${owner}/${name}`); }
  catch (e) {
    if (!/not found/i.test(e.message)) throw e;
    return gh('/user/repos', { method:'POST',
      body: { name, private: !!isPrivate, auto_init: false,
              description: 'Built with Mini' } });
  }
}

const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/**
 * Puts every file in one commit on the default branch.
 * @returns {{url, branch, commit, created}}
 */
export async function pushProject({ repo, files, message = 'Update from Mini', private: priv = false }) {
  const me = await whoami();
  const owner = me.login;
  const name = String(repo || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 90) || 'mini-app';

  const info = await ensureRepo(owner, name, priv);
  const branch = info.default_branch || 'main';
  const base = `/repos/${owner}/${name}`;

  // Blobs first, then a tree that references them.
  const tree = [];
  for (const [path, content] of Object.entries(files)) {
    const blob = await gh(`${base}/git/blobs`, { method:'POST',
      body: { content: b64(content), encoding: 'base64' } });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  let parent = null;
  try {
    const ref = await gh(`${base}/git/ref/heads/${branch}`);
    parent = ref.object.sha;
  } catch { /* an empty repository has no ref yet */ }

  const newTree = await gh(`${base}/git/trees`, { method:'POST',
    body: parent ? { tree, base_tree: undefined } : { tree } });

  const commit = await gh(`${base}/git/commits`, { method:'POST',
    body: { message, tree: newTree.sha, parents: parent ? [parent] : [] } });

  if (parent) {
    await gh(`${base}/git/refs/heads/${branch}`, { method:'PATCH',
      body: { sha: commit.sha, force: true } });
  } else {
    await gh(`${base}/git/refs`, { method:'POST',
      body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  }

  return { url: info.html_url, branch, commit: commit.sha.slice(0, 7), created: !parent,
           owner, repo: name };
}

/** Reads one file out of a repository, for importing an existing project. */
export async function readFile(owner, repo, path, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await gh(`/repos/${owner}/${repo}/contents/${path}${q}`);
  if (Array.isArray(data)) return { dir: data.map(x => ({ name:x.name, type:x.type, size:x.size })) };
  const bin = atob(String(data.content || '').replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return { text: new TextDecoder().decode(bytes), size: data.size };
}
