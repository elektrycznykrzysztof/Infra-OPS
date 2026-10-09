import { config, fetchOptions } from "./config";

export class UpstreamError extends Error {
  constructor(public system: string, public status: number, message: string) { super(message); }
}

export async function requestJson<T>(system: string, url: string, init: RequestInit = {}, insecure = false): Promise<T> {
  const response = await fetch(url, { ...fetchOptions(insecure), ...init } as any);
  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    throw new UpstreamError(system, response.status, text || response.statusText);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function hasValidBasicAuth(header?: string | null) {
  if (!config.auth.username || !config.auth.password || !header?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return decoded.slice(0, separator) === config.auth.username && decoded.slice(separator + 1) === config.auth.password;
  } catch { return false; }
}

export function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  if (!origin || (origin !== requestOrigin && !config.origins.includes(origin))) {
    throw new UpstreamError("security", 403, "Origin nie jest zgodny z adresem panelu ani listą WEB_ORIGINS");
  }
}

export const basicHeader = (username: string, password: string) => `Basic ${btoa(`${username}:${password}`)}`;
