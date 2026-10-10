/** Small injectable client for the tabula-cloud internal admin API. */
export function createFlyLoadAdminClient({ baseUrl, token, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    throw new Error('ADMIN_URL must be a bare HTTP(S) base URL without credentials, path, query, or fragment');
  }
  if (!token) throw new Error('ADMIN_TOKEN is required');

  return {
    async request(method, route, body, { signal } = {}) {
      const url = new URL(route, base);
      const response = await fetchImpl(url, {
        method,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
      const text = await response.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      return { status: response.status, body: parsed };
    },
  };
}
