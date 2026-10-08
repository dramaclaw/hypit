import { createMarkupSurfaceHostFacet } from "@hypit/markup";

import { cosyVoiceComponent, cosyVoiceManifest, cosyVoiceMarkupSurfaces, cosyVoiceModuleRef, decodeCosyVoiceDesignSurface, decodeCosyVoiceSpeechSurface } from "./index.js";

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  modules: [{ manifest: cosyVoiceManifest }],
  components: [cosyVoiceComponent],
  hostFacets: [
    createMarkupSurfaceHostFacet({ module: cosyVoiceModuleRef, declaration: cosyVoiceMarkupSurfaces[0]!, handler: decodeCosyVoiceDesignSurface }),
    createMarkupSurfaceHostFacet({ module: cosyVoiceModuleRef, declaration: cosyVoiceMarkupSurfaces[1]!, handler: decodeCosyVoiceSpeechSurface }),
  ],
};

export default hypitPackage;
