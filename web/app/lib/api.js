/**
 * API client.
 *
 * The access token is held in memory only. The refresh token lives in an
 * HttpOnly cookie the browser cannot read, so a successful XSS still cannot
 * exfiltrate a durable credential. A 401 triggers exactly one silent refresh;
 * concurrent callers share it.
 */

const BASE = (window.DIROX_API_URL || '').replace(/\/$/, '');

class ApiError extends Error {
  constructor(message, { status, code, details, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isQuota() { return this.status === 402 || this.status === 429; }
  get isOffline() { return this.status === 0; }
}

let accessToken = '';
let orgId = '';
let refreshPromise = null;
const listeners = new Set();

function emit(event, payload) {
  for (const listener of listeners) listener(event, payload);
}

export const api = {
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },

  get token() { return accessToken; },
  setToken(token) { accessToken = token || ''; },
  setOrg(id) { orgId = id || ''; },
  get orgId() { return orgId; },

  headers(extra = {}) {
    const headers = { ...extra };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (orgId) headers['X-Dirox-Org'] = orgId;
    return headers;
  },

  async request(path, { method = 'GET', body, signal, retryOn401 = true, raw = false } = {}) {
    let response;
    try {
      response = await fetch(`${BASE}/api${path}`, {
        method,
        signal,
        credentials: 'include',
        headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError('Cannot reach DiroxCode. Check your connection.', { status: 0, code: 'offline' });
    }

    if (response.status === 401 && retryOn401 && accessToken) {
      const refreshed = await this.refreshSession();
      if (refreshed) return this.request(path, { method, body, signal, retryOn401: false, raw });
      emit('signed-out');
    }

    if (response.status === 204) return null;
    if (raw) return response;

    const text = await response.text();
    let payload = null;
    if (text) { try { payload = JSON.parse(text); } catch { payload = { message: text }; } }

    if (!response.ok) {
      const error = payload?.error || {};
      throw new ApiError(error.message || payload?.message || 'Something went wrong', {
        status: response.status, code: error.code, details: error.details, requestId: error.requestId
      });
    }
    return payload;
  },

  get(path, options) { return this.request(path, { ...options, method: 'GET' }); },
  post(path, body, options) { return this.request(path, { ...options, method: 'POST', body }); },

  /**
   * Send a file. The body is the file itself — no multipart envelope, because
   * there is one field and its name fits in a header.
   */
  async upload(path, file, { signal } = {}) {
    const response = await fetch(`${BASE}/api${path}`, {
      method: 'POST',
      signal,
      credentials: 'include',
      headers: this.headers({
        'Content-Type': file.type || 'application/octet-stream',
        // A filename may hold anything a filesystem allows; a header may not.
        'X-Upload-Name': encodeURIComponent(file.name || 'upload')
      }),
      body: file
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = payload?.error || {};
      throw new ApiError(error.message || 'The upload failed', { status: response.status, code: error.code });
    }
    return payload;
  },
  put(path, body, options) { return this.request(path, { ...options, method: 'PUT', body }); },
  patch(path, body, options) { return this.request(path, { ...options, method: 'PATCH', body }); },
  delete(path, options) { return this.request(path, { ...options, method: 'DELETE' }); },

  /** Exchange the refresh cookie for a new access token. At most one in flight. */
  async refreshSession() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const response = await fetch(`${BASE}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        if (!response.ok) return false;
        const data = await response.json();
        if (!data?.accessToken) return false;
        accessToken = data.accessToken;
        emit('token-refreshed', data);
        return true;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  },

  /**
   * Open a server-sent event stream for agent activity.
   * @returns {{ close: () => void }}
   */
  stream(path, { onEvent, onError, signal } = {}) {
    const controller = new AbortController();
    if (signal) signal.addEventListener('abort', () => controller.abort());

    (async () => {
      try {
        const response = await fetch(`${BASE}/api${path}`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: this.headers({ Accept: 'text/event-stream' })
        });
        if (!response.ok || !response.body) {
          throw new ApiError('The activity stream could not be opened', { status: response.status });
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (chunk.startsWith(':')) continue;  // keep-alive comment

            let event = 'message';
            const dataLines = [];
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            try { onEvent?.(event, JSON.parse(dataLines.join('\n'))); }
            catch { onEvent?.(event, { raw: dataLines.join('\n') }); }
          }
        }
      } catch (error) {
        if (error?.name !== 'AbortError') onError?.(error);
      }
    })();

    return { close: () => controller.abort() };
  }
};

export { ApiError };
