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
    return { profile: context.profile, changed: false, credentials: [] };
  }
  if (!context.interactive || context.readText === undefined || context.readSecret === undefined) {
    throw new Error(`NewAPI is the default for this Runtime, but ${inspection.missing.join(", ")} is missing; run runtime up in an interactive terminal to configure it`);
  }
  const completed = completeNewApiSetup({
    baseUrl: await requiredLine(context, "NewAPI address: "),
    apiKey: await requiredSecret(context, "NewAPI API key: "),
    relay: await relayAnswers(context),
  });
  return {
    profile: replaceEndpointConfig(context.profile, completed.config),
    changed: true,
    credentials: completed.credentials.map((item) => ({ endpoint: endpointName, ...item })),
  };
}
