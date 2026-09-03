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

function isProtocolSensitive(path) {
  return (
    (path.startsWith("contracts/") && !path.startsWith("contracts/test/")) ||
    path.startsWith("ignition/modules/") ||
    path === "hardhat.config.ts" ||
    path === "package.json" ||
    path === "package-lock.json" ||
    path === "scripts/deploy-base-sepolia.mjs" ||
    path === "scripts/production-artifacts.mjs" ||
    path === "scripts/sync-abi.mjs"
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

export function protocolFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter(isProtocolSensitive)
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

export function releaseFingerprintAtCommit(root, commit) {
  const paths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "-z", commit],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .filter(isReleaseSensitive)
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root }));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function protocolFingerprint(root) {
  const hash = createHash("sha256");
  for (const path of protocolFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function protocolFingerprintAtCommit(root, commit) {
  const paths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "-z", commit],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .filter(isProtocolSensitive)
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root }));
    hash.update("\0");
  }
  return hash.digest("hex");
}
