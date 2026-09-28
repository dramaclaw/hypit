import {
  compileWireRequest,
  generationTypes,
  selectWireModelForRequest,
} from "@hypit/generation";
import type {
  GenerationArtifactUrlResolver,
  GenerationRequest,
  GenerationWireMapping,
} from "@hypit/generation";
import type { EndpointRequest, EndpointSupport } from "@hypit/endpoint-kit";
import type { CapabilityRef, CanonicalValue, TypeRef } from "@hypit/protocol";

import { newApiMappings } from "./mapping.js";

export type NewApiPreparedRequest = {
  readonly model: string;
  readonly result: "image" | "video";
  readonly compile: (resolve: GenerationArtifactUrlResolver) => Promise<Record<string, unknown>>;
};

export type NewApiRoute = GenerationWireMapping & {
  readonly key: string;
  readonly returns: TypeRef;
  readonly supports: (request: EndpointRequest) => EndpointSupport;
  readonly prepare: (constraints: CanonicalValue) => NewApiPreparedRequest;
};

const IMAGE_RATIOS: Readonly<Record<string, readonly string[]>> = {
  "LingShan-G2": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"],
  "LingShan-NB-2": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5", "1:4", "4:1", "1:8", "8:1"],
  "LingShan-NB-Pro": ["1:1", "9:16", "16:9", "4:3", "3:4", "2:3", "3:2", "5:4", "4:5", "21:9"],
  "seedream-5.0-lite": ["1:1", "16:9", "9:16", "3:2", "3:4", "21:9", "2:3", "4:3"],
};

function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function rejection(mapping: GenerationWireMapping, request: GenerationRequest): string | undefined {
  const model = selectWireModelForRequest(mapping, request);
  const ratio = String(scalar(request, "aspectRatio"));
  if (mapping.result === "image" && !(IMAGE_RATIOS[model] ?? []).includes(ratio)) {
    return `DramaClaw NewAPI ${model} does not support aspect ratio ${ratio}`;
  }
  if (mapping.capability.name === "seedream-5-lite" && scalar(request, "quality") === "ultra") {
    return "DramaClaw NewAPI seedream-5.0-lite supports 2K basic or 3K high, not 4K ultra";
  }
  if (mapping.capability.module.name === "@hypit/seedance") {
    if (mapping.capability.name !== "seedance-2.5" && ratio === "adaptive") {
      return `DramaClaw NewAPI ${model} does not advertise adaptive aspect ratio`;
    }
    if (mapping.capability.name === "seedance-2.5" && scalar(request, "duration") === -1) {
      return "DramaClaw NewAPI seedance-2.5 requires an explicit duration from 4 to 30 seconds";
    }
  }
  return undefined;
}

function normalize(mapping: GenerationWireMapping, input: Record<string, unknown>): Record<string, unknown> {
  if (mapping.capability.name === "seedream-5-lite") {
    input.resolution = input.quality === "basic" ? "2K" : "3K";
    delete input.quality;
    delete input.nsfw_check;
  }
  if (mapping.capability.module.name === "@hypit/seedance") {
    if (input.aspect_ratio === "adaptive") input.aspect_ratio = "auto";
    if (input.resolution === "4k") input.resolution = "4K";
  }
  return input;
}

function capabilityKey(capability: CapabilityRef): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}

export const newApiRoutes: readonly NewApiRoute[] = newApiMappings.map((mapping) => ({
  ...mapping,
  key: capabilityKey(mapping.capability),
  returns: mapping.result === "image" ? generationTypes.imageSet : generationTypes.videoSet,
  supports: (request) => {
    const reason = rejection(mapping, request.constraints as unknown as GenerationRequest);
    return reason === undefined ? { status: "supported" } : { status: "unsupported", reason };
  },
  prepare: (constraints) => {
    if (mapping.result !== "image" && mapping.result !== "video") {
      throw new Error(`DramaClaw NewAPI does not implement ${mapping.result} routes`);
    }
    const request = constraints as unknown as GenerationRequest;
    const reason = rejection(mapping, request);
    if (reason !== undefined) throw new Error(reason);
    const model = selectWireModelForRequest(mapping, request);
    return {
      model,
      result: mapping.result,
      compile: async (resolve) => normalize(mapping,
        (await compileWireRequest(mapping, request, resolve)).input as Record<string, unknown>),
    };
  },
}));

const routesByCapability = new Map(newApiRoutes.map((route) => [route.key, route]));

export function newApiRouteForCapability(capability: CapabilityRef): NewApiRoute | undefined {
  return routesByCapability.get(capabilityKey(capability));
}
