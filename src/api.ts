const API_ROOT = '/api';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly data: Record<string, unknown> | null) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers
    }
  });
  const data = await response.json().catch(() => null) as ({ message?: string } & Record<string, unknown>) | null;
  if (!response.ok) throw new ApiError(data?.message || '本地服务暂时无法完成这个操作。', response.status, data);
  return data as T;
}

async function stream(path: string, body: unknown, onEvent: (event: Record<string, unknown>) => void, signal?: AbortSignal) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(data?.message || '本地服务暂时无法完成这个操作。');
  }
  if (!response.body) throw new Error('当前环境无法读取实时进度。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as Record<string, unknown>);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as Record<string, unknown>);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: JSON.stringify(body ?? {}) }),
  stream
};
