import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  artifactSetFingerprint,
  assertRuntimeMatchesArtifact,
  loadProductionArtifacts,
} from "../../scripts/production-artifacts.mjs";
import { releaseFingerprint } from "../../scripts/release-fingerprint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(
  root,
  "app/src/lib/deployments/base-sepolia.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const objectIdPattern = /^[0-9a-f]{40}$/;
const expectedRulesetId =
  "0x2952c211fea32cbfec3555f0c4b2abe175950d5b268d05044b013cca59c2ad8b";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function retry(operation, description) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, 1_000 * (attempt + 1)),
        );
      }
    }
  }
  throw new Error(`${description} failed`, { cause: lastError });
}

assert.equal(manifest.schemaVersion, 1, "unsupported deployment schema");
assert.equal(manifest.project, "QueenCheck", "unexpected project name");
assert.equal(manifest.network, "base-sepolia", "unexpected network name");
assert.equal(manifest.chainId, baseSepolia.id, "unexpected chain id");
assert.ok(
  manifest.status === "not-deployed" || manifest.status === "deployed",
  "invalid deployment status",
);

if (manifest.status === "not-deployed") {
  assert.deepEqual(manifest.contracts, {}, "undeployed manifest has contracts");
  console.log("Base Sepolia manifest is valid and intentionally undeployed.");
  process.exit(0);
}

assert.match(manifest.source.commit, objectIdPattern, "invalid source commit");
assert.match(manifest.source.tree, objectIdPattern, "invalid source tree");
assert.match(
  manifest.source.releaseFingerprintSha256,
  /^[0-9a-f]{64}$/,
  "invalid release fingerprint",
);
assert.match(
  manifest.source.repository,
  /^https:\/\/github\.com\/[^/]+\/[^/]+$/,
);
assert.equal(
  manifest.source.url,
  `${manifest.source.repository}/tree/${manifest.source.commit}`,
);
assert.equal(
  git(["rev-parse", `${manifest.source.commit}^{tree}`]),
  manifest.source.tree,
  "manifest source tree does not match its commit",
);
assert.equal(
  spawnSync("git", ["merge-base", "--is-ancestor", manifest.source.commit, "HEAD"], {
    cwd: root,
  }).status,
  0,
  "deployment source commit is not an ancestor of HEAD",
);
assert.equal(
  releaseFingerprint(root),
  manifest.source.releaseFingerprintSha256,
  "release-sensitive files differ from the deployed source",
);

assert.equal(manifest.build.profile, "production");
assert.equal(manifest.build.solidity, "0.8.28");
assert.equal(manifest.build.evmVersion, "cancun");
assert.equal(manifest.build.optimizerRuns, 500);
assert.equal(manifest.build.viaIR, true);
assert.equal(
  manifest.build.lockfiles.rootSha256,
  sha256(resolve(root, "package-lock.json")),
  "root lockfile differs from the deployed release",
);
assert.equal(
  manifest.build.lockfiles.appSha256,
  sha256(resolve(root, "app/package-lock.json")),
  "app lockfile differs from the deployed release",
);
assert.equal(
  manifest.build.abiSha256,
  sha256(resolve(root, "app/src/lib/contracts/abi.generated.js")),
  "generated ABI differs from the deployed release",
);
const productionArtifacts = loadProductionArtifacts(root);
assert.equal(
  manifest.build.artifactSetSha256,
  artifactSetFingerprint(productionArtifacts),
  "production artifact set differs from the deployed release",
);

assert.equal(
  manifest.deployment.id,
  `queencheck-${manifest.source.commit}`,
  "deployment id is not commit-bound",
);
assert.match(manifest.deployment.deployer, addressPattern);
assert.ok(Number.isSafeInteger(manifest.deployment.blockNumber));
assert.ok(!Number.isNaN(Date.parse(manifest.deployment.timestamp)));
assert.equal(manifest.rulesetId, expectedRulesetId, "unexpected ruleset id");
assert.equal(manifest.verification.provider, "sourcify");
assert.ok(!Number.isNaN(Date.parse(manifest.verification.checkedAt)));

const expectedContracts = [
  "rulesEngine",
  "gameImplementation",
  "renderer",
  "factory",
  "record",
];
assert.deepEqual(
  Object.keys(manifest.contracts).sort(),
  [...expectedContracts].sort(),
);

const addresses = new Set();
for (const name of expectedContracts) {
  const contract = manifest.contracts[name];
  assert.match(contract.address, addressPattern, `${name} address is invalid`);
  assert.match(
    contract.creationTransactionHash,
    bytes32Pattern,
    `${name} transaction hash is invalid`,
  );
  assert.match(
    contract.runtimeCodeHash,
    bytes32Pattern,
    `${name} runtime code hash is invalid`,
  );
  assert.ok(Number.isSafeInteger(contract.blockNumber), `${name} block is invalid`);
  assert.equal(contract.sourceVerification, "exact_match");
  assert.equal(
    contract.artifactSha256,
    productionArtifacts[name].artifactSha256,
    `${name} artifact fingerprint differs from the deployed release`,
  );
  assert.equal(
    contract.compilerInputSha256,
    productionArtifacts[name].compilerInputSha256,
    `${name} compiler input differs from the deployed release`,
  );
  assert.equal(contract.buildInfoId, productionArtifacts[name].buildInfoId);
  assert.equal(
    contract.normalizedRuntimeCodeSha256,
    productionArtifacts[name].normalizedRuntimeCodeSha256,
  );
  assert.equal(
    contract.sourcifyUrl,
    `https://repo.sourcify.dev/${baseSepolia.id}/${contract.address}`,
  );
  assert.equal(
    contract.explorerUrl,
    `https://sepolia.basescan.org/address/${contract.address}`,
  );
  addresses.add(contract.address.toLowerCase());
}
assert.equal(addresses.size, expectedContracts.length, "contract addresses repeat");

const { contracts, relationships } = manifest;
const declaredRelationships = {
  implementation: contracts.gameImplementation.address,
  rules: contracts.rulesEngine.address,
  renderer: contracts.renderer.address,
  record: contracts.record.address,
};
for (const [name, address] of Object.entries(declaredRelationships)) {
  assert.equal(relationships.factory[name].toLowerCase(), address.toLowerCase());
}
assert.equal(
  relationships.record.factory.toLowerCase(),
  contracts.factory.address.toLowerCase(),
);
assert.equal(
  relationships.record.renderer.toLowerCase(),
  contracts.renderer.address.toLowerCase(),
);

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(
    process.env.QUEENCHECK_READ_RPC_URL || "https://sepolia.base.org",
    { timeout: 15_000 },
  ),
});
assert.equal(await retry(() => client.getChainId(), "chain-id lookup"), baseSepolia.id);

await Promise.all(
  expectedContracts.map(async (name) => {
    const contract = contracts[name];
    const bytecode = await retry(
      () => client.getBytecode({ address: getAddress(contract.address) }),
      `${name} bytecode lookup`,
    );
    assert.ok(bytecode && bytecode !== "0x", `${name} has no runtime bytecode`);
    assert.equal(keccak256(bytecode), contract.runtimeCodeHash, `${name} code hash mismatch`);
    assertRuntimeMatchesArtifact(bytecode, productionArtifacts[name], name);

    const response = await retry(
      () =>
        fetch(
          `https://sourcify.dev/server/v2/contract/${baseSepolia.id}/${contract.address}`,
          { signal: AbortSignal.timeout(15_000) },
        ),
      `${name} Sourcify lookup`,
    );
    assert.equal(response.ok, true, `${name} is absent from Sourcify`);
    const verification = await response.json();
    assert.equal(verification.match, "exact_match", `${name} source match is not exact`);
    assert.equal(verification.creationMatch, "exact_match");
    assert.equal(verification.runtimeMatch, "exact_match");
  }),
);

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
const liveFactoryRelationships = Object.fromEntries(
  await Promise.all(
    ["implementation", "rules", "renderer", "record"].map(async (functionName) => [
      functionName,
      getAddress(
        await retry(
          () =>
            client.readContract({
              address: getAddress(contracts.factory.address),
              abi: factoryAbi,
              functionName,
            }),
          `factory.${functionName}`,
        ),
      ),
    ]),
  ),
);
for (const [name, address] of Object.entries(declaredRelationships)) {
  assert.equal(liveFactoryRelationships[name], getAddress(address));
}
const [liveRecordFactory, liveRecordRenderer] = await Promise.all(
  ["factory", "renderer"].map((functionName) =>
    retry(
      () =>
        client.readContract({
          address: getAddress(contracts.record.address),
          abi: recordAbi,
          functionName,
        }),
      `record.${functionName}`,
    ),
  ),
);
assert.equal(getAddress(liveRecordFactory), getAddress(contracts.factory.address));
assert.equal(getAddress(liveRecordRenderer), getAddress(contracts.renderer.address));

for (const name of expectedContracts.filter((name) => name !== "record")) {
  const contract = contracts[name];
  const [receipt, transaction] = await Promise.all([
    retry(
      () => client.getTransactionReceipt({ hash: contract.creationTransactionHash }),
      `${name} receipt lookup`,
    ),
    retry(
      () => client.getTransaction({ hash: contract.creationTransactionHash }),
      `${name} transaction lookup`,
    ),
  ]);
  assert.equal(receipt.status, "success");
  assert.equal(getAddress(receipt.contractAddress), getAddress(contract.address));
  assert.equal(Number(receipt.blockNumber), contract.blockNumber);
  assert.equal(getAddress(transaction.from), getAddress(manifest.deployment.deployer));
}
assert.equal(
  contracts.record.creationTransactionHash,
  contracts.factory.creationTransactionHash,
  "record must be created inside the factory transaction",
);

console.log(
  `Base Sepolia manifest and live deployment are valid for ${manifest.source.commit.slice(0, 12)}.`,
);
