import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire("/tmp/downloader/package.json");
const { fetch, EnvHttpProxyAgent } = require("undici");
const [version, architecture] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version) || !["amd64", "arm64"].includes(architecture)) {
  throw new Error("Expected a release version and amd64 or arm64 architecture");
}
const dispatcher = new EnvHttpProxyAgent();
async function download(name) {
  const response = await fetch(`https://github.com/gastownhall/beads/releases/download/v${version}/${name}`, { dispatcher });
  if (!response.ok) throw new Error(`Release download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  const name = `beads_${version}_linux_${architecture}.tar.gz`;
  const [archive, checksums] = await Promise.all([download(name), download("checksums.txt")]);
  const expected = checksums.toString().split("\n").find((line) => line.trim().endsWith(name))?.trim().split(/\s+/)[0];
  if (!expected || createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("Beads release checksum mismatch");
  await writeFile("/tmp/beads.tar.gz", archive);
} finally {
  await dispatcher.close();
}
