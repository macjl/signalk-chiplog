import { deviceToken } from './auth.mjs';

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

const responseListeners = new Set();

// Called with every response from the server and when it was sent and received,
// which the tablet uses to learn the server's clock.
export function onResponse(listener) {
  responseListeners.add(listener);
  return () => responseListeners.delete(listener);
}

export async function request(method, path, body, { timeoutMs } = {}) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  const token = deviceToken.get();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  // A flaky boat Wi-Fi can leave a request hanging far longer than the crew
  // should wait; AbortController rather than AbortSignal.timeout, for older tablets.
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const sentAt = Date.now();
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal
    });
  } catch (err) {
    throw new RequestError(0, 'network', err.message);
  } finally {
    clearTimeout(timer);
  }
  const receivedAt = Date.now();
  responseListeners.forEach((listener) => listener(response, sentAt, receivedAt));

  if (response.status === 204) {
    return null;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // A device token the server no longer accepts has been revoked or expired.
    if (response.status === 401 && token) {
      deviceToken.clear();
    }
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
