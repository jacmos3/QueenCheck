import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  artifactSetFingerprint,
  assertRuntimeMatchesArtifact,
  loadProductionArtifacts,
} from "./production-artifacts.mjs";
import { releaseFingerprint } from "./release-fingerprint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
  root,
  "app/src/lib/deployments/base-sepolia.json",
);
const rpcUrl =
  process.env.QUEENCHECK_READ_RPC_URL || "https://sepolia.base.org";

function fail(message) {
  throw new Error(message);
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeRepository(remote) {
  let value = remote.trim().replace(/\.git$/, "");
  if (value.startsWith("git@github.com:")) {
    value = `https://github.com/${value.slice("git@github.com:".length)}`;
  } else if (value.startsWith("ssh://git@github.com/")) {
    value = `https://github.com/${value.slice("ssh://git@github.com/".length)}`;
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(value)) {
    fail("origin must be a canonical GitHub repository before deployment");
  }
  return value;
}

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function readDeploymentTransactions() {
  const journal = readFileSync(resolve(deploymentDir, "journal.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const initialization = journal.find(
    (entry) => entry.type === "DEPLOYMENT_INITIALIZE",
  );
  if (initialization?.chainId !== baseSepolia.id) {
    fail("Ignition journal does not belong to Base Sepolia");
  }

  const transactions = new Map();
  const deployers = new Set();
  for (const entry of journal) {
    if (
      entry.type === "DEPLOYMENT_EXECUTION_STATE_INITIALIZE" &&
      typeof entry.from === "string"
    ) {
      deployers.add(getAddress(entry.from));
    }
    if (
      entry.type === "TRANSACTION_CONFIRM" &&
      entry.receipt?.status === "SUCCESS" &&
      typeof entry.hash === "string"
    ) {
      transactions.set(entry.futureId, {
        hash: entry.hash,
        blockNumber: entry.receipt.blockNumber,
      });
    }
  }
  if (deployers.size !== 1) fail("deployment used more than one sender");
  return { transactions, deployer: [...deployers][0] };
}

async function exactSourcifyMatch(address) {
  const url = `https://sourcify.dev/server/v2/contract/${baseSepolia.id}/${address}`;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const result = await response.json();
      if (
        result.match === "exact_match" &&
        result.creationMatch === "exact_match" &&
        result.runtimeMatch === "exact_match"
      ) {
        return {
          match: result.match,
          verifiedAt: result.verifiedAt,
          url: `https://repo.sourcify.dev/${baseSepolia.id}/${address}`,
        };
      }
      if (result.match !== null && result.match !== undefined) {
        fail(`Sourcify did not produce an exact match for ${address}`);
      }
    } else if (response.status !== 404) {
      fail(`Sourcify lookup failed for ${address}: HTTP ${response.status}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  fail(`Sourcify exact-match confirmation timed out for ${address}`);
}

const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status !== "") fail("refusing to deploy from a dirty working tree");
if (git(["branch", "--show-current"]) !== "main") {
  fail("refusing to deploy from a branch other than main");
}

const sourceCommit = git(["rev-parse", "HEAD"]);
const upstreamName = git([
  "rev-parse",
  "--abbrev-ref",
  "--symbolic-full-name",
  "@{upstream}",
]);
if (upstreamName !== "origin/main") {
  fail("main must track origin/main before deployment");
}
const upstreamCommit = git(["rev-parse", "@{upstream}"]);
if (sourceCommit !== upstreamCommit) {
  fail("refusing to deploy a commit that is not the published upstream HEAD");
}
const sourceTree = git(["rev-parse", "HEAD^{tree}"]);
const repository = normalizeRepository(git(["remote", "get-url", "origin"]));
const remoteMain = git(["ls-remote", "origin", "refs/heads/main"])
  .split(/\s+/)[0];
if (remoteMain !== sourceCommit) {
  fail("origin/main on GitHub is not the local release commit");
}
const deploymentId = `queencheck-${sourceCommit}`;
const deploymentDir = resolve(root, "ignition/deployments", deploymentId);

run(
  "npx",
  [
    "hardhat",
    "--build-profile",
    "production",
    "ignition",
    "deploy",
    "ignition/modules/QueenCheck.ts",
    "--network",
    "baseSepolia",
    "--deployment-id",
    deploymentId,
    "--verify",
  ],
  { HARDHAT_IGNITION_CONFIRM_DEPLOYMENT: "true" },
);

const rawAddresses = JSON.parse(
  readFileSync(resolve(deploymentDir, "deployed_addresses.json"), "utf8"),
);
const addresses = {
  rulesEngine: getAddress(rawAddresses["QueenCheck#ChessRulesEngine"]),
  gameImplementation: getAddress(rawAddresses["QueenCheck#QueenCheckGame"]),
  renderer: getAddress(rawAddresses["QueenCheck#QueenCheckRenderer"]),
  factory: getAddress(rawAddresses["QueenCheck#QueenCheckFactory"]),
};
const { transactions, deployer } = readDeploymentTransactions();
const futureIds = {
  rulesEngine: "QueenCheck#ChessRulesEngine",
  gameImplementation: "QueenCheck#QueenCheckGame",
  renderer: "QueenCheck#QueenCheckRenderer",
  factory: "QueenCheck#QueenCheckFactory",
};
for (const futureId of Object.values(futureIds)) {
  if (!transactions.has(futureId)) fail(`missing confirmed transaction for ${futureId}`);
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl, { timeout: 15_000 }),
});
if ((await client.getChainId()) !== baseSepolia.id) fail("RPC chain id mismatch");

const factoryAbi = parseAbi([
  "function implementation() view returns (address)",
  "function rules() view returns (address)",
  "function renderer() view returns (address)",
  "function record() view returns (address)",
]);
const recordAbi = parseAbi([
  "function factory() view returns (address)",
  "function renderer() view returns (address)",
]);
const [factoryImplementation, factoryRules, factoryRenderer, rawRecord] =
  await Promise.all(
    ["implementation", "rules", "renderer", "record"].map((functionName) =>
      client.readContract({
        address: addresses.factory,
        abi: factoryAbi,
        functionName,
      }),
    ),
  );
addresses.record = getAddress(rawRecord);
if (getAddress(factoryImplementation) !== addresses.gameImplementation) {
  fail("factory implementation relationship does not match Ignition output");
}
if (getAddress(factoryRules) !== addresses.rulesEngine) {
  fail("factory rules relationship does not match Ignition output");
}
if (getAddress(factoryRenderer) !== addresses.renderer) {
  fail("factory renderer relationship does not match Ignition output");
}
const [recordFactory, recordRenderer] = await Promise.all(
  ["factory", "renderer"].map((functionName) =>
    client.readContract({
      address: addresses.record,
      abi: recordAbi,
      functionName,
    }),
  ),
);
if (getAddress(recordFactory) !== addresses.factory) {
  fail("record does not point back to the deployed factory");
}
if (getAddress(recordRenderer) !== addresses.renderer) {
  fail("record does not point to the deployed renderer");
}

const factoryTransaction = transactions.get(futureIds.factory);
run("npx", [
  "hardhat",
  "--build-profile",
  "production",
  "verify",
  "sourcify",
  "--network",
  "baseSepolia",
  "--contract",
  "contracts/QueenCheckRecord.sol:QueenCheckRecord",
  "--creation-tx-hash",
  factoryTransaction.hash,
  addresses.record,
  addresses.factory,
  addresses.renderer,
]);

const verificationEntries = await Promise.all(
  Object.values(addresses).map(async (address) => [
    address,
    await exactSourcifyMatch(address),
  ]),
);
const verifications = new Map(verificationEntries);
const productionArtifacts = loadProductionArtifacts(root);

const contractEntries = {};
for (const [name, address] of Object.entries(addresses)) {
  const bytecode = await client.getBytecode({ address });
  if (!bytecode || bytecode === "0x") fail(`no runtime bytecode at ${address}`);
  const transaction =
    name === "record"
      ? factoryTransaction
      : transactions.get(futureIds[name]);
  const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
  if (receipt.status !== "success") fail(`deployment transaction reverted for ${name}`);
  if (
    name !== "record" &&
    getAddress(receipt.contractAddress) !== address
  ) {
    fail(`receipt address does not match ${name}`);
  }
  const verification = verifications.get(address);
  assertRuntimeMatchesArtifact(bytecode, productionArtifacts[name], name);
  contractEntries[name] = {
    address,
    creationTransactionHash: transaction.hash,
    blockNumber: Number(receipt.blockNumber),
    runtimeCodeHash: keccak256(bytecode),
    artifactSha256: productionArtifacts[name].artifactSha256,
    compilerInputSha256: productionArtifacts[name].compilerInputSha256,
    buildInfoId: productionArtifacts[name].buildInfoId,
    normalizedRuntimeCodeSha256:
      productionArtifacts[name].normalizedRuntimeCodeSha256,
    sourceVerification: verification.match,
    verifiedAt: verification.verifiedAt,
    sourcifyUrl: verification.url,
    explorerUrl: `https://sepolia.basescan.org/address/${address}`,
  };
}

const factoryReceipt = await client.getTransactionReceipt({
  hash: factoryTransaction.hash,
});
const deploymentBlock = await client.getBlock({
  blockNumber: factoryReceipt.blockNumber,
});
const manifest = {
  schemaVersion: 1,
  project: "QueenCheck",
  network: "base-sepolia",
  chainId: baseSepolia.id,
  status: "deployed",
  source: {
    repository,
    commit: sourceCommit,
    tree: sourceTree,
    releaseFingerprintSha256: releaseFingerprint(root),
    url: `${repository}/tree/${sourceCommit}`,
  },
  build: {
    profile: "production",
    solidity: "0.8.28",
    evmVersion: "cancun",
    optimizerRuns: 500,
    viaIR: true,
    lockfiles: {
      rootSha256: sha256(resolve(root, "package-lock.json")),
      appSha256: sha256(resolve(root, "app/package-lock.json")),
    },
    abiSha256: sha256(resolve(root, "app/src/lib/contracts/abi.generated.js")),
    artifactSetSha256: artifactSetFingerprint(productionArtifacts),
  },
  deployment: {
    id: deploymentId,
    deployer,
    blockNumber: Number(factoryReceipt.blockNumber),
    timestamp: new Date(Number(deploymentBlock.timestamp) * 1000).toISOString(),
  },
  rulesetId: keccak256(stringToHex("QUEENCHECK_STANDARD_CHESS_V1")),
  contracts: contractEntries,
  relationships: {
    factory: {
      implementation: getAddress(factoryImplementation),
      rules: getAddress(factoryRules),
      renderer: getAddress(factoryRenderer),
      record: addresses.record,
    },
    record: {
      factory: getAddress(recordFactory),
      renderer: getAddress(recordRenderer),
    },
  },
  verification: {
    provider: "sourcify",
    api: "https://sourcify.dev/server/v2",
    checkedAt: new Date().toISOString(),
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
run(process.execPath, ["scripts/check-deployment-manifest.mjs"]);
console.log(`Wrote verified deployment manifest to ${manifestPath}`);
