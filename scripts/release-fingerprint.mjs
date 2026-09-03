import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const excludedFiles = new Set([
  ".gitignore",
  "AGENTS.md",
  "LICENSE.md",
  "README.md",
  "SECURITY.md",
  "app/src/lib/deployments/base-sepolia.json",
]);

function isReleaseSensitive(path) {
  return (
    !excludedFiles.has(path) &&
    !path.startsWith(".github/") &&
    !path.startsWith("docs/")
  );
}

export function releaseFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter(isReleaseSensitive)
    .sort();
}

export function releaseFingerprint(root) {
  const hash = createHash("sha256");
  for (const path of releaseFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
