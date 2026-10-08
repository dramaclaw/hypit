const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isPublicOssHost(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length !== 3 && labels.length !== 4) return false;
  const oss = labels.length === 3 ? labels[0] : labels[1];
  if (labels.length === 4 && !/^[a-z0-9][a-z0-9-]*$/u.test(labels[0]!)) return false;
  return labels.at(-2) === "aliyuncs" && labels.at(-1) === "com"
    && /^oss-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(oss!) && !oss!.endsWith("-internal");
}

export function assertTrustedAudioAssetUrl(url: string, baseUrl: string, origins: readonly string[] = []): void {
  let destination: URL;
  try { destination = new URL(url); }
  catch { throw new Error("DramaClaw NewAPI speech response has an invalid audio URL"); }
  const base = new URL(baseUrl);
  const sameOrigin = destination.origin === base.origin;
  const loopbackHttp = base.protocol === "http:" && loopbackHosts.has(base.hostname) && sameOrigin;
  if ((destination.protocol !== "https:" && !loopbackHttp)
    || destination.username.length > 0 || destination.password.length > 0
    || destination.hash.length > 0 || (destination.port.length > 0 && !loopbackHttp)
    || !(sameOrigin || origins.includes(destination.origin) || isPublicOssHost(destination.hostname))) {
    throw new Error("DramaClaw NewAPI speech response has an untrusted audio URL");
  }
}
