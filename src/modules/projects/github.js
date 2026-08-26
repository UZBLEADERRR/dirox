/**
 * GitHub integration.
 *
 * Tokens are encrypted at rest and never leave the server. The client sees
 * repository metadata only. Every call goes through one request function so
 * rate-limit handling and error mapping are consistent.
 */

import { config } from '../../config/env.js';
import { AppError, badRequest, forbidden, notConfigured, upstreamFailed, rateLimited } from '../../core/errors.js';
import { decryptSecret, encryptSecret, randomToken } from '../../core/crypto.js';
import { hasServiceRole, serviceClient } from '../../db/supabase.js';
import { logger } from '../../core/logger.js';

const API = 'https://github.com';
const REST = 'https://api.github.com';

/** Short-lived OAuth state, held in memory: a restart just means "sign in again". */
const pendingStates = new Map();

export function beginOAuth(userId, returnTo = '/app/projects') {
  if (!config.github.clientId) throw notConfigured('GitHub integration');
  const state = randomToken(24);
  pendingStates.set(state, { userId, returnTo, expires: Date.now() + 600_000 });

  // Opportunistic sweep so the map cannot grow without bound.
  if (pendingStates.size > 500) {
    for (const [key, value] of pendingStates) if (value.expires < Date.now()) pendingStates.delete(key);
  }

  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: config.github.callback || `${config.appUrl}/api/github/callback`,
    scope: 'repo read:user user:email',
    state
  });
  return { url: `${API}/login/oauth/authorize?${params}`, state };
}

export function consumeState(state) {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expires < Date.now()) throw forbidden('This GitHub authorization link has expired. Please try again.');
  return entry;
}

export async function exchangeCode(code) {
  if (!config.github.clientSecret) throw notConfigured('GitHub integration');
  const response = await fetch(`${API}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: config.github.callback || `${config.appUrl}/api/github/callback`
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw upstreamFailed(data.error_description || 'GitHub did not return an access token');
  }
  return data.access_token;
}

async function githubRequest(token, path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${REST}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'DiroxCode',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const resetAt = Number(response.headers.get('x-ratelimit-reset') || 0) * 1000;
      throw rateLimited('GitHub API rate limit reached', { retryAfterMs: Math.max(0, resetAt - Date.now()) });
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new AppError(data?.message || 'GitHub request failed', {
        status: response.status === 404 ? 404 : response.status === 401 ? 401 : 502,
        code: 'github_error',
        retryable: response.status >= 500
      });
    }
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === 'AbortError') throw upstreamFailed('GitHub request timed out');
    throw upstreamFailed('Could not reach GitHub', { reason: error?.message });
  } finally {
    clearTimeout(timer);
  }
}

export async function getViewer(token) {
  const [user, emails] = await Promise.all([
    githubRequest(token, '/user'),
    githubRequest(token, '/user/emails').catch(() => [])
  ]);
  const primary = Array.isArray(emails) ? emails.find(e => e.primary)?.email : null;
  return { login: user.login, name: user.name, avatarUrl: user.avatar_url, email: primary || user.email };
}

export async function listRepositories(token, { page = 1, perPage = 50, query = '' } = {}) {
  if (query) {
    const search = await githubRequest(token, `/search/repositories?q=${encodeURIComponent(`${query} in:name fork:true`)}&per_page=${perPage}`);
    return (search.items || []).map(shapeRepository);
  }
  const repos = await githubRequest(token, `/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
  return (repos || []).map(shapeRepository);
}

function shapeRepository(repo) {
  return {
    id: String(repo.id),
    name: repo.name,
    owner: repo.owner?.login,
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    defaultBranch: repo.default_branch,
    htmlUrl: repo.html_url,
    cloneUrl: repo.clone_url,
    language: repo.language,
    sizeKb: repo.size,
    updatedAt: repo.updated_at
  };
}

export async function listBranches(token, fullName) {
  const branches = await githubRequest(token, `/repos/${fullName}/branches?per_page=100`);
  return (branches || []).map(branch => ({ name: branch.name, sha: branch.commit?.sha }));
}

/**
 * Download a repository as a tarball.
 * Used by the clone job; keeps `git` out of the request path entirely.
 */
export async function downloadTarball(token, fullName, ref) {
  const response = await fetch(`${REST}/repos/${fullName}/tarball/${encodeURIComponent(ref || '')}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'DiroxCode' },
    redirect: 'follow'
  });
  if (!response.ok) throw upstreamFailed(`GitHub could not provide an archive for ${fullName}`);
  return response;
}

export async function createPullRequest(token, fullName, { title, head, base, body }) {
  return githubRequest(token, `/repos/${fullName}/pulls`, {
    method: 'POST',
    body: { title, head, base, body: body || '' }
  });
}

export async function getFileContent(token, fullName, path, ref) {
  const data = await githubRequest(token, `/repos/${fullName}/contents/${encodeURIComponent(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
  if (data?.encoding === 'base64') return Buffer.from(data.content, 'base64').toString('utf8');
  return null;
}

// ─── token storage ──────────────────────────────────────────────────────────

/** Repository tokens live encrypted on the repositories row. */
export async function storeRepositoryToken(repositoryId, token) {
  await serviceClient().from('repositories').eq('id', repositoryId).update({
    access_token_enc: encryptSecret(token)
  });
}

export async function repositoryToken(repositoryId) {
  const row = await serviceClient().from('repositories').select('access_token_enc').eq('id', repositoryId).first();
  if (!row?.access_token_enc) throw badRequest('This repository is not connected to GitHub. Reconnect it to continue.');
  return decryptSecret(row.access_token_enc);
}

/** Never return the token column to a caller. */
export const REPOSITORY_COLUMNS = 'id,project_id,provider,external_id,owner,name,full_name,html_url,default_branch,visibility,last_synced_at,sync_error,created_at';

export { githubRequest, shapeRepository };

// ─── per-user connected accounts ────────────────────────────────────────────

/** Persist a user's GitHub connection. One row per user per provider. */
export async function saveIntegration(userId, provider, token, account, scopes = []) {
  if (!hasServiceRole()) throw notConfigured('Connected accounts (SUPABASE_SERVICE_ROLE_KEY)');
  return serviceClient().insert('user_integrations', {
    user_id: userId,
    provider,
    external_id: account?.id ? String(account.id) : null,
    account_login: account?.login ?? null,
    account_name: account?.name ?? null,
    avatar_url: account?.avatarUrl ?? null,
    scopes,
    access_token_enc: encryptSecret(token),
    revoked_at: null
  }, { upsert: true, onConflict: 'user_id,provider' });
}

/** @returns {Promise<string>} the decrypted token, or '' when not connected. */
export async function getIntegrationToken(userId, provider = 'github') {
  if (!hasServiceRole()) return '';
  const row = await serviceClient().from('user_integrations')
    .select('id,access_token_enc,revoked_at')
    .eq('user_id', userId).eq('provider', provider).first();
  if (!row?.access_token_enc || row.revoked_at) return '';
  try {
    serviceClient().from('user_integrations').eq('id', row.id)
      .update({ last_used_at: new Date().toISOString() }).catch(() => {});
    return decryptSecret(row.access_token_enc);
  } catch (error) {
    logger.warn('stored integration token could not be decrypted', { provider, reason: error?.message });
    return '';
  }
}

export async function getIntegration(userId, provider = 'github') {
  if (!hasServiceRole()) return null;
  const row = await serviceClient().from('user_integrations')
    .select('id,provider,account_login,account_name,avatar_url,scopes,last_used_at,revoked_at,created_at')
    .eq('user_id', userId).eq('provider', provider).first();
  return row && !row.revoked_at ? row : null;
}

export async function revokeIntegration(userId, provider = 'github') {
  if (!hasServiceRole()) return;
  await serviceClient().from('user_integrations')
    .eq('user_id', userId).eq('provider', provider)
    .update({ revoked_at: new Date().toISOString(), access_token_enc: encryptSecret('revoked') });
}
