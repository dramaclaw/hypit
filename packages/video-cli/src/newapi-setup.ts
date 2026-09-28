import { completeNewApiSetup, inspectNewApiSetup } from "@dramaclaw/provider-newapi";
import type { CliRuntimeProfileSetupContext, CliRuntimeProfileSetupResult } from "@hypit/cli";
import type { CanonicalValue } from "@hypit/protocol";

const endpointName = "newapi.personal";
const providerName = "@dramaclaw/provider-newapi";

function objectValue(value: CanonicalValue | undefined): Record<string, CanonicalValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, CanonicalValue>
    : undefined;
}

async function requiredLine(context: CliRuntimeProfileSetupContext, prompt: string): Promise<string> {
  const value = await context.readText!(prompt);
  if (value.trim().length === 0) throw new Error(`${prompt.trim()} is required`);
  return value;
}

async function requiredSecret(context: CliRuntimeProfileSetupContext, prompt: string): Promise<string> {
  const value = await context.readSecret!(prompt);
  if (value.trim().length === 0) throw new Error(`${prompt.trim()} is required`);
  return value;
}

async function relayAnswers(context: CliRuntimeProfileSetupContext): Promise<
  { readonly enabled: false } | {
    readonly enabled: true;
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly accessKeySecret: string;
  }
> {
  for (;;) {
    const answer = (await context.readText!("Configure OSS relay for generated media? [y/n]: ")).trim().toLowerCase();
    if (["n", "no", "否"].includes(answer)) return { enabled: false };
    if (["y", "yes", "是"].includes(answer)) {
      return {
        enabled: true,
        endpoint: await requiredLine(context, "OSS Endpoint: "),
        bucket: await requiredLine(context, "OSS Bucket: "),
        accessKeyId: await requiredSecret(context, "OSS AccessKey ID: "),
        accessKeySecret: await requiredSecret(context, "OSS AccessKey Secret: "),
      };
    }
  }
}

function replaceEndpointConfig(profile: CanonicalValue, config: CanonicalValue): CanonicalValue {
  const root = objectValue(profile)!;
  const endpoints = objectValue(root.endpoints)!;
  const endpoint = objectValue(endpoints[endpointName])!;
  return {
    ...root,
    endpoints: {
      ...endpoints,
      [endpointName]: { ...endpoint, config },
    },
  };
}

function requiredCredentials(config: CanonicalValue): readonly { readonly endpoint: string; readonly slots: readonly string[] }[] {
  const item = objectValue(config);
  const hasRef = (value: CanonicalValue | undefined) => {
    const ref = objectValue(value);
    return typeof ref?.store === "string" && ref.store.length > 0
      && typeof ref.key === "string" && ref.key.length > 0;
  };
  const completeRelay = typeof item?.relayEndpoint === "string" && item.relayEndpoint.trim().length > 0
    && typeof item.relayBucket === "string" && item.relayBucket.trim().length > 0
    && hasRef(item.relayAccessKeyId) && hasRef(item.relayAccessKeySecret);
  return [{ endpoint: endpointName, slots: !completeRelay
    ? ["apiKey"] : ["apiKey", "relayAccessKeyId", "relayAccessKeySecret"] }];
}

function preserveCredentialRefs(profile: CanonicalValue, existing: CanonicalValue, completed: CanonicalValue): CanonicalValue {
  const current = objectValue(existing) ?? {};
  const next = objectValue(completed)!;
  const keyRef = objectValue(current.apiKey);
  const selectedStores = Object.keys(objectValue(objectValue(profile)?.credentials) ?? {});
  const store = typeof keyRef?.store === "string" ? keyRef.store
    : selectedStores.length === 1 ? selectedStores[0] : undefined;
  if (store === undefined) throw new Error("NewAPI API credential store is ambiguous; select an apiKey CredentialRef in the Runtime Profile");
  const merged: Record<string, CanonicalValue> = { ...current, ...next };
  for (const slot of ["apiKey", "relayAccessKeyId", "relayAccessKeySecret"] as const) {
    if (next[slot] === undefined) continue;
    merged[slot] = current[slot] ?? { ...objectValue(next[slot])!, store };
  }
  if (next.relayEndpoint === undefined) {
    for (const field of ["relayEndpoint", "relayBucket", "relayAccessKeyId", "relayAccessKeySecret", "relayTtlSeconds"]) {
      delete merged[field];
    }
  }
  return merged;
}

/** Configure the selected video's NewAPI Endpoint before its first Runtime startup. */
export async function configureNewApiRuntimeBeforeUp(
  context: CliRuntimeProfileSetupContext,
): Promise<CliRuntimeProfileSetupResult> {
  const root = objectValue(context.profile);
  const endpoints = root === undefined ? undefined : objectValue(root.endpoints);
  const endpoint = endpoints === undefined ? undefined : objectValue(endpoints[endpointName]);
  if (endpoint?.use !== providerName) {
    return { profile: context.profile, changed: false, credentials: [] };
  }
  const inspection = inspectNewApiSetup(endpoint.config ?? null);
  if (inspection.configured) {
    return { profile: context.profile, changed: false, credentials: [],
      requiredCredentials: requiredCredentials(endpoint.config ?? null) };
  }
  if (!context.interactive || context.readText === undefined || context.readSecret === undefined) {
    throw new Error(`NewAPI is the default for this Runtime, but ${inspection.missing.join(", ")} is missing; run runtime up in an interactive terminal to configure it`);
  }
  const completed = completeNewApiSetup({
    baseUrl: await requiredLine(context, "NewAPI address: "),
    apiKey: await requiredSecret(context, "NewAPI API key: "),
    relay: await relayAnswers(context),
  });
  const config = preserveCredentialRefs(context.profile, endpoint.config ?? null, completed.config);
  return {
    profile: replaceEndpointConfig(context.profile, config),
    changed: true,
    credentials: completed.credentials.map((item) => ({ endpoint: endpointName, ...item })),
    requiredCredentials: requiredCredentials(config),
  };
}
