const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Share the API prefix between setup probes and generation requests. */
export function normalizeNewApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("DramaClaw NewAPI baseUrl must be a valid HTTPS or loopback HTTP URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) {
    throw new Error("DramaClaw NewAPI baseUrl must use HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("DramaClaw NewAPI baseUrl must not contain credentials, query parameters or fragments");
  }
  // An explicit non-root path is already the caller's API prefix.
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/v1";
  return url.toString();
}
