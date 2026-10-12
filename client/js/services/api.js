function readCsrf() {
  const match = document.cookie.match(/(?:^|; )cp_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = readCsrf();

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const error = new Error('The ride service is unreachable.');
    error.status = 0;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}
