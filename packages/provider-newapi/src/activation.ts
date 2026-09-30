import { createRuntimeEndpointAdapterFacet } from "@hypit/runtime-kit";

import { parseNewApiEndpointConfig } from "./config.js";
import { createNewApiProvider } from "./provider.js";

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@dramaclaw/provider-newapi",
  activate(context) {
    if (context.pool === undefined) throw new Error("DramaClaw NewAPI Provider Pool is required");
    const config = parseNewApiEndpointConfig(context.config);
    return {
      endpoint: createNewApiProvider({
        instance: context.instance,
        pool: context.pool,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        ...(config.relay === undefined ? {} : { relay: config.relay }),
        ...(config.defaultConcurrency === undefined ? {} : { defaultConcurrency: config.defaultConcurrency }),
        ...(config.actionLimits === undefined ? {} : { actionLimits: config.actionLimits }),
        ...(config.pollIntervalMs === undefined ? {} : { pollIntervalMs: config.pollIntervalMs }),
        ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
        ...(config.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: config.operationTimeoutMs }),
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  hostFacets: [adapter],
};

export default hypitPackage;
