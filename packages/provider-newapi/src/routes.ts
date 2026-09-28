import {
  compileWireRequest,
  generationTypes,
  sealGeneratedImageSet,
  sealGeneratedVideoSet,
  selectWireModelForRequest,
} from "@hypit/generation";
import type {
  GenerationArtifactUrlResolver,
  GenerationRequest,
  GenerationWireMapping,
} from "@hypit/generation";
import type { EndpointRequest, EndpointSupport } from "@hypit/endpoint-kit";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CapabilityRef, CanonicalValue, StoredValue, TypeRef } from "@hypit/protocol";

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
  readonly packageResult: (artifacts: readonly BlobRef[]) => StoredValue;
};

const IMAGE_RATIOS: Readonly<Record<string, readonly string[]>> = {
  "LingShan-G2": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"],
  "LingShan-NB-2": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5", "1:4", "4:1", "1:8", "8:1"],
  "LingShan-NB-Pro": ["1:1", "9:16", "16:9", "4:3", "3:4", "2:3", "3:2", "5:4", "4:5", "21:9"],
  "seedream-5.0-lite": ["1:1", "16:9", "9:16", "3:2", "3:4", "21:9", "2:3", "4:3"],
};

// Snapshot of the DramaClaw image catalog and its image-size request contract.
// Keep constraints here, with the exact model routes; no external repository is needed at runtime.
const IMAGE_GEOMETRY = Object.fromEntries(Object.keys(IMAGE_RATIOS).map((model) => [model, {
  resolutions: model === "seedream-5.0-lite" ? ["2K", "3K"] : ["1K", "2K", "4K"],
  minPixels: model === "seedream-5.0-lite" ? 3_686_400 : 655_360,
  maxPixels: 8_294_400, maxEdge: 3840, alignment: 16,
}]));

function imageDimensions(model: string, resolution: string, ratio: string) {
  const limits = IMAGE_GEOMETRY[model]!;
  const [rw, rh] = ratio.split(":").map(Number);
  const longEdge = ({ "1K": 1024, "2K": 2048, "3K": 3072, "4K": 3840 } as Record<string, number>)[resolution]!;
  let width = longEdge * rw! / Math.max(rw!, rh!);
  let height = longEdge * rh! / Math.max(rw!, rh!);
  const pixels = Math.min(limits.maxPixels, Math.max(limits.minPixels, width * height));
  const scale = Math.sqrt(pixels / (width * height));
  width *= scale; height *= scale;
  const ceil = (value: number) => Math.ceil(value / limits.alignment) * limits.alignment;
  const floor = (value: number) => Math.floor(value / limits.alignment) * limits.alignment;
  if (ceil(width) * ceil(height) > limits.maxPixels) {
    width = floor(width); height = floor(height);
  } else {
    width = ceil(width); height = ceil(height);
  }
  if (width * height < limits.minPixels || Math.max(width, height) > limits.maxEdge) {
    throw new Error(`DramaClaw NewAPI ${model} does not support ${resolution} at ${ratio}`);
  }
  return { width, height };
}

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
  // Provider contract: this gateway fixes content safety on and exposes no opt-out field.
  if (mapping.capability.name === "seedream-5-lite" && scalar(request, "nsfwCheck") !== true) {
    return "DramaClaw NewAPI seedream-5.0-lite content safety checks cannot be disabled";
  }
  if (mapping.result === "image") {
    const resolution = model === "seedream-5.0-lite"
      ? scalar(request, "quality") === "basic" ? "2K" : "3K" : String(scalar(request, "resolution"));
    if (!IMAGE_GEOMETRY[model]!.resolutions.includes(resolution)) {
      return `DramaClaw NewAPI ${model} does not support resolution ${resolution}`;
    }
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

function normalize(mapping: GenerationWireMapping, model: string, input: Record<string, unknown>): Record<string, unknown> {
  if (mapping.capability.name === "seedream-5-lite") {
    input.resolution = input.quality === "basic" ? "2K" : "3K";
    delete input.quality;
    // Only true reaches normalization; the fixed gateway policy needs no request field.
    delete input.nsfw_check;
  }
  if (mapping.result === "image") {
    Object.assign(input, imageDimensions(model, String(input.resolution), String(input.aspect_ratio)));
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
      compile: async (resolve) => normalize(mapping, model,
        (await compileWireRequest(mapping, request, resolve)).input as Record<string, unknown>),
    };
  },
  packageResult: (artifacts) => ({
    kind: "inline",
    value: canonicalize(mapping.result === "image"
      ? sealGeneratedImageSet({ images: artifacts })
      : sealGeneratedVideoSet({ videos: artifacts })),
  }),
}));

const routesByCapability = new Map(newApiRoutes.map((route) => [route.key, route]));

export function newApiRouteForCapability(capability: CapabilityRef): NewApiRoute | undefined {
  return routesByCapability.get(capabilityKey(capability));
}
