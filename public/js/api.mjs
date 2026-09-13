const BASE = '/plugins/signalk-chiplog/api';

export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function apiUrl(path) {
  return `${BASE}${path}`;
}

export async function request(method, path, body) {
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new RequestError(0, 'network', err.message);
  }

  if (response.status === 204) {
    return null;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // Signal K answers access refusals itself, without the plugin's envelope.
    const code =
      response.status === 401 || response.status === 403
        ? 'forbidden'
        : (data?.error?.code ?? 'http_error');
    throw new RequestError(response.status, code, data?.error?.message ?? response.statusText);
  }
  return data;
}

export const get = (path) => request('GET', path);

export async function fetchAll(path) {
  const separator = path.includes('?') ? '&' : '?';
  const items = [];
  for (;;) {
    const page = await get(`${path}${separator}limit=500&offset=${items.length}`);
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) {
      return items;
    }
  }
}
