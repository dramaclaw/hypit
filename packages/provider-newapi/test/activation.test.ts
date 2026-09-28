import assert from "node:assert/strict";
import test from "node:test";

import hypitPackage, { hypitPackage as namedPackage } from "../src/activation.js";

test("exports exactly one DramaClaw NewAPI runtime adapter", () => {
  assert.equal(hypitPackage, namedPackage);
  assert.equal(hypitPackage.format, "hypit.node-package@1");
  assert.equal(hypitPackage.hostFacets.length, 1);
});
