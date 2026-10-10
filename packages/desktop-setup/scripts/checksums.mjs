import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function writeChecksum(artifact) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(artifact)) hash.update(bytes);
  const checksum = hash.digest("hex");
  await writeFile(`${artifact}.sha256`, `${checksum}  ${basename(artifact)}\n`);
  return checksum;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Expected an installer path");
  console.log(await writeChecksum(resolve(process.argv[2])));
}
