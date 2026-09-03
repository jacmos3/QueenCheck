import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const contractArtifacts = {
  rulesEngine:
    "artifacts/contracts/chess/ChessRulesEngine.sol/ChessRulesEngine.json",
  gameImplementation:
    "artifacts/contracts/QueenCheckGame.sol/QueenCheckGame.json",
  renderer:
    "artifacts/contracts/QueenCheckRenderer.sol/QueenCheckRenderer.json",
  factory:
    "artifacts/contracts/QueenCheckFactory.sol/QueenCheckFactory.json",
  record: "artifacts/contracts/QueenCheckRecord.sol/QueenCheckRecord.json",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function localSourcePath(root, inputName) {
  if (inputName.startsWith("project/")) {
    return resolve(root, inputName.slice("project/".length));
  }
  const openZeppelinPrefix = "npm/@openzeppelin/contracts@5.6.1/";
  if (inputName.startsWith(openZeppelinPrefix)) {
    return resolve(
      root,
      "node_modules/@openzeppelin/contracts",
      inputName.slice(openZeppelinPrefix.length),
    );
  }
  throw new Error(`unsupported compiler input source: ${inputName}`);
}

function immutableRanges(references) {
  const ranges = Object.values(references ?? {})
    .flat()
    .map(({ start, length }) => ({ start, length }))
    .sort((left, right) => left.start - right.start || left.length - right.length);
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    assert.ok(Number.isSafeInteger(range.start) && range.start >= 0);
    assert.ok(Number.isSafeInteger(range.length) && range.length > 0);
    if (index > 0) {
      const previous = ranges[index - 1];
      assert.ok(
        previous.start + previous.length <= range.start,
        "immutable bytecode references overlap",
      );
    }
  }
  return ranges;
}

export function normalizeRuntimeBytecode(bytecode, ranges) {
  assert.match(bytecode, /^0x(?:[0-9a-fA-F]{2})*$/, "invalid runtime bytecode");
  const normalized = bytecode.slice(2).toLowerCase().split("");
  for (const { start, length } of ranges) {
    const characterStart = start * 2;
    const characterLength = length * 2;
    assert.ok(
      characterStart + characterLength <= normalized.length,
      "immutable reference exceeds runtime bytecode",
    );
    normalized.fill("0", characterStart, characterStart + characterLength);
  }
  return `0x${normalized.join("")}`;
}

export function assertRuntimeMatchesArtifact(runtimeBytecode, artifact, label) {
  assert.equal(
    normalizeRuntimeBytecode(runtimeBytecode, artifact.immutableRanges),
    artifact.normalizedRuntimeBytecode,
    `${label} runtime bytecode was not produced by the current production build`,
  );
}

export function loadProductionArtifacts(root) {
  const result = {};
  for (const [name, artifactRelativePath] of Object.entries(contractArtifacts)) {
    const artifactPath = resolve(root, artifactRelativePath);
    const artifactRaw = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactRaw);
    assert.equal(artifact._format, "hh3-artifact-1");
    assert.deepEqual(artifact.deployedLinkReferences, {});

    const buildInfoPath = resolve(
      root,
      `artifacts/build-info/${artifact.buildInfoId}.json`,
    );
    const buildOutputPath = resolve(
      root,
      `artifacts/build-info/${artifact.buildInfoId}.output.json`,
    );
    const buildInfoRaw = readFileSync(buildInfoPath);
    const buildInfo = JSON.parse(buildInfoRaw);
    const buildOutput = readJson(buildOutputPath).output;
    assert.equal(buildInfo.id, artifact.buildInfoId);
    assert.equal(buildInfo.solcVersion, "0.8.28");
    assert.equal(buildInfo.input.settings.evmVersion, "cancun");
    assert.equal(buildInfo.input.settings.optimizer.enabled, true);
    assert.equal(buildInfo.input.settings.optimizer.runs, 500);
    assert.equal(buildInfo.input.settings.viaIR, true);

    for (const [inputName, source] of Object.entries(buildInfo.input.sources)) {
      assert.equal(
        source.content,
        readFileSync(localSourcePath(root, inputName), "utf8"),
        `${inputName} differs from the production compiler input`,
      );
    }

    const compilerContract =
      buildOutput.contracts?.[artifact.inputSourceName]?.[artifact.contractName];
    assert.ok(compilerContract, `${name} is absent from its compiler output`);
    assert.equal(
      `0x${compilerContract.evm.deployedBytecode.object}`,
      artifact.deployedBytecode,
      `${name} artifact differs from its compiler output`,
    );
    assert.deepEqual(
      compilerContract.evm.deployedBytecode.immutableReferences ?? {},
      artifact.immutableReferences ?? {},
      `${name} immutable references differ from compiler output`,
    );

    const ranges = immutableRanges(artifact.immutableReferences);
    const normalizedRuntimeBytecode = normalizeRuntimeBytecode(
      artifact.deployedBytecode,
      ranges,
    );
    result[name] = {
      artifactSha256: sha256(artifactRaw),
      compilerInputSha256: sha256(buildInfoRaw),
      buildInfoId: artifact.buildInfoId,
      immutableRanges: ranges,
      normalizedRuntimeBytecode,
      normalizedRuntimeCodeSha256: sha256(normalizedRuntimeBytecode),
    };
  }
  return result;
}

export function artifactSetFingerprint(artifacts) {
  const entries = Object.keys(contractArtifacts)
    .sort()
    .map((name) => [
      name,
      {
        artifactSha256: artifacts[name].artifactSha256,
        compilerInputSha256: artifacts[name].compilerInputSha256,
        buildInfoId: artifacts[name].buildInfoId,
        immutableRanges: artifacts[name].immutableRanges,
        normalizedRuntimeCodeSha256:
          artifacts[name].normalizedRuntimeCodeSha256,
      },
    ]);
  return sha256(JSON.stringify(entries));
}
