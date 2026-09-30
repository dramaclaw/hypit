const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function normalizeNewApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("DramaClaw NewAPI baseUrl must be a valid HTTPS or loopback HTTP URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) {
    throw new Error("DramaClaw NewAPI baseUrl must use HTTPS or loopback HTTP");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("DramaClaw NewAPI baseUrl must not contain credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("DramaClaw NewAPI baseUrl must not contain a query or fragment");
  }
  return trimmed;
}
