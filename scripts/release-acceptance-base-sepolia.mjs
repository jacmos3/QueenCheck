import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  zeroAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  factoryAbi,
  gameAbi,
  recordAbi,
} from "../app/src/lib/contracts/abi.generated.js";
import {
  moveTypedData,
  nextTranscriptRoot,
} from "../app/src/lib/eip712.js";
import { matchRecordTokenId } from "../app/src/lib/game-actions.js";
import {
  mergeTranscripts,
  parseTranscriptJson,
  TRANSCRIPT_SCHEMA,
  validateTranscriptContinuation,
} from "../app/src/lib/transcript.js";
import {
  protocolFingerprint,
  protocolFingerprintAtCommit,
} from "./release-fingerprint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(
    resolve(root, "app/src/lib/deployments/base-sepolia.json"),
    "utf8",
  ),
);
const mnemonic = process.env.QC_ACCEPTANCE_MNEMONIC?.trim() ?? "";
const rpcUrl = process.env.QC_ACCEPTANCE_RPC_URL?.trim() ?? "";
const minimumBalance = 500_000_000_000_000n;
let evidence;
let evidencePath;
let persistEvidence;

function fail(message) {
  throw new Error(message);
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function accountIndex(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function contractRevert(error) {
  if (error instanceof ContractFunctionRevertedError) return error;
  if (typeof error?.walk !== "function") return null;
  try {
    return (
      error.walk((cause) => cause instanceof ContractFunctionRevertedError) ??
      null
    );
  } catch {
    return null;
  }
}

function redactedText(value) {
  let message = String(value);
  for (const secret of [mnemonic, rpcUrl]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/0x[0-9a-fA-F]{67,}/g, "[redacted-hex-payload]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1_000);
}

function redactedError(error) {
  return redactedText(error instanceof Error ? error.message : error);
}

async function expectContractRevert(
  label,
  expectedErrorName,
  operation,
  checks,
) {
  try {
    await operation();
  } catch (error) {
    const revert = contractRevert(error);
    if (!revert) throw error;
    assert.equal(
      revert.data?.errorName,
      expectedErrorName,
      `${label} reverted with an unexpected custom error`,
    );
    checks.push({
      name: label,
      result: "passed",
      expectedError: expectedErrorName,
    });
    return;
  }
  fail(`${label} unexpectedly succeeded`);
}

function checkpointMove(move) {
  return {
    gameId: BigInt(move.gameId),
    rulesetId: move.rulesetId,
    ply: Number(move.ply),
    prevTranscriptRoot: move.prevTranscriptRoot,
    fromSquare: Number(move.fromSquare),
    toSquare: Number(move.toSquare),
    promotion: Number(move.promotion),
  };
}

function metadataSnapshot(uri) {
  const jsonPrefix = "data:application/json;base64,";
  const svgPrefix = "data:image/svg+xml;base64,";
  assert.ok(uri.startsWith(jsonPrefix), "record metadata is not an onchain JSON data URI");
  const metadata = JSON.parse(
    Buffer.from(uri.slice(jsonPrefix.length), "base64").toString("utf8"),
  );
  assert.equal(typeof metadata.name, "string");
  assert.equal(typeof metadata.image, "string");
  assert.ok(metadata.image.startsWith(svgPrefix), "record image is not an SVG data URI");
  const svg = Buffer.from(
    metadata.image.slice(svgPrefix.length),
    "base64",
  ).toString("utf8");
  assert.match(svg, /^<svg\b/);
  const attributes = Object.fromEntries(
    (metadata.attributes ?? []).map((item) => [item.trait_type, item.value]),
  );
  assert.equal(typeof metadata.player, "string");
  assert.equal(typeof metadata.transcript_root, "string");
  return {
    name: metadata.name,
    ply: Number(attributes.Ply),
    state: Number(attributes.State),
    player: getAddress(metadata.player),
    transcriptRoot: metadata.transcript_root,
    tokenUriHash: keccak256(stringToHex(uri)),
    svgHash: keccak256(stringToHex(svg)),
  };
}

function assertMetadata(snapshot, expected) {
  assert.equal(snapshot.name, `QueenCheck #${expected.gameId}`);
  assert.equal(snapshot.ply, expected.ply);
  assert.equal(snapshot.state, expected.state);
  assert.equal(snapshot.player, getAddress(expected.player));
  assert.equal(
    snapshot.transcriptRoot.toLowerCase(),
    expected.transcriptRoot.toLowerCase(),
  );
}

async function main() {
  if (!mnemonic) fail("QC_ACCEPTANCE_MNEMONIC is required");
  if (!rpcUrl) fail("QC_ACCEPTANCE_RPC_URL is required");
  if (manifest.status !== "deployed" || manifest.chainId !== baseSepolia.id) {
    fail("the committed Base Sepolia deployment manifest is not active");
  }
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    fail("refusing to run release acceptance from a dirty working tree");
  }
  if (git(["branch", "--show-current"]) !== "main") {
    fail("refusing to run release acceptance outside main");
  }
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const upstreamName = git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstreamName !== "origin/main") {
    fail("main must track origin/main before release acceptance");
  }
  if (git(["rev-parse", "@{upstream}"]) !== sourceCommit) {
    fail("refusing to run release acceptance before origin/main is synchronized");
  }
  const remoteMain = git(["ls-remote", "origin", "refs/heads/main"])
    .split(/\s+/)[0];
  if (remoteMain !== sourceCommit) {
    fail("origin/main on GitHub is not the local release commit");
  }
  if (
    spawnSync(
      "git",
      ["merge-base", "--is-ancestor", manifest.source.commit, sourceCommit],
      { cwd: root },
    ).status !== 0
  ) {
    fail("the deployment source is not an ancestor of this release");
  }
  const currentProtocolFingerprint = protocolFingerprint(root);
  assert.equal(
    currentProtocolFingerprint,
    protocolFingerprintAtCommit(root, manifest.source.commit),
    "current protocol source differs from the deployed protocol",
  );
  const checkerEnvironment = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  checkerEnvironment.QUEENCHECK_READ_RPC_URL = rpcUrl;
  console.log("Verifying the committed manifest and live deployment...");
  const deploymentCheck = spawnSync(
    process.execPath,
    [resolve(root, "scripts/check-deployment-manifest.mjs")],
    {
      cwd: root,
      env: checkerEnvironment,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (deploymentCheck.error) throw deploymentCheck.error;
  if (deploymentCheck.status !== 0) {
    fail(
      `deployment integrity check failed: ${redactedError(
        new Error(`${deploymentCheck.stdout}\n${deploymentCheck.stderr}`),
      )}`,
    );
  }
  if (deploymentCheck.stdout.trim()) {
    console.log(redactedText(deploymentCheck.stdout).trim());
  }

  const whiteIndex = accountIndex("QC_ACCEPTANCE_WHITE_INDEX", 0);
  const blackIndex = accountIndex("QC_ACCEPTANCE_BLACK_INDEX", 1);
  const relayerIndex = accountIndex("QC_ACCEPTANCE_RELAYER_INDEX", 4);
  const white = mnemonicToAccount(mnemonic, { addressIndex: whiteIndex });
  const black = mnemonicToAccount(mnemonic, { addressIndex: blackIndex });
  const relayer = mnemonicToAccount(mnemonic, { addressIndex: relayerIndex });
  assert.equal(
    new Set([white.address, black.address, relayer.address].map((address) =>
      getAddress(address),
    )).size,
    3,
    "white, black, and relayer accounts must be distinct",
  );

  const transport = http(rpcUrl, {
    retryCount: 3,
    retryDelay: 1_000,
    timeout: 30_000,
  });
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const whiteClient = createWalletClient({
    account: white,
    chain: baseSepolia,
    transport,
  });
  const blackClient = createWalletClient({
    account: black,
    chain: baseSepolia,
    transport,
  });
  const relayerClient = createWalletClient({
    account: relayer,
    chain: baseSepolia,
    transport,
  });
  assert.equal(await publicClient.getChainId(), baseSepolia.id);

  const [whiteBalanceBefore, blackBalanceBefore, relayerBalanceBefore] = await Promise.all([
    publicClient.getBalance({ address: white.address }),
    publicClient.getBalance({ address: black.address }),
    publicClient.getBalance({ address: relayer.address }),
  ]);
  assert.ok(whiteBalanceBefore >= minimumBalance, "white test account has insufficient Base Sepolia ETH");
  assert.ok(blackBalanceBefore >= minimumBalance, "black test account has insufficient Base Sepolia ETH");
  assert.ok(relayerBalanceBefore >= minimumBalance, "relayer test account has insufficient Base Sepolia ETH");

  evidencePath = resolve(
    process.env.QC_ACCEPTANCE_OUTPUT ||
      resolve(
        tmpdir(),
        `queencheck-base-sepolia-acceptance-${sourceCommit.slice(0, 12)}.json`,
      ),
  );
  evidence = {
    schema: "queencheck.release-acceptance/v1",
    status: "running",
    startedAt: new Date().toISOString(),
    network: "base-sepolia",
    chainId: baseSepolia.id,
    release: {
      commit: sourceCommit,
      deployedProtocolCommit: manifest.source.commit,
      protocolFingerprintSha256: currentProtocolFingerprint,
      factory: getAddress(manifest.contracts.factory.address),
      record: getAddress(manifest.contracts.record.address),
    },
    accounts: {
      white: {
        address: getAddress(white.address),
        derivationAddressIndex: whiteIndex,
        balanceBeforeEth: formatEther(whiteBalanceBefore),
      },
      black: {
        address: getAddress(black.address),
        derivationAddressIndex: blackIndex,
        balanceBeforeEth: formatEther(blackBalanceBefore),
      },
      relayer: {
        address: getAddress(relayer.address),
        derivationAddressIndex: relayerIndex,
        balanceBeforeEth: formatEther(relayerBalanceBefore),
      },
    },
    games: {},
    transactions: [],
    checks: [],
  };
  persistEvidence = () =>
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  const check = (name, details = {}) => {
    evidence.checks.push({ name, result: "passed", ...details });
    persistEvidence();
  };
  const submit = async (step, walletClient, request) => {
    const simulation = await publicClient.simulateContract({
      ...request,
      account: walletClient.account,
    });
    const hash = await walletClient.writeContract(simulation.request);
    console.log(`${step}: ${hash}`);
    const transaction = {
      step,
      hash,
      from: getAddress(walletClient.account.address),
      result: "submitted",
    };
    evidence.transactions.push(transaction);
    persistEvidence();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 180_000,
    });
    assert.equal(receipt.status, "success", `${step} reverted`);
    Object.assign(transaction, {
      result: "confirmed",
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed.toString(),
    });
    persistEvidence();
    return receipt;
  };
  const readGame = async (game) => {
    const [
      status,
      whitePlayer,
      blackPlayer,
      invitedPlayer,
      whiteTurn,
      ply,
      gameId,
      rulesetId,
      stateHash,
      transcriptRoot,
      board,
    ] = await Promise.all([
      "status",
      "whitePlayer",
      "blackPlayer",
      "invitedPlayer",
      "whiteTurn",
      "ply",
      "gameId",
      "rulesetId",
      "stateHash",
      "transcriptRoot",
      "getBoard",
    ].map((functionName) =>
      publicClient.readContract({
        address: game,
        abi: gameAbi,
        functionName,
      }),
    ));
    return {
      status: Number(status),
      white: getAddress(whitePlayer),
      black: getAddress(blackPlayer),
      invited: getAddress(invitedPlayer),
      whiteTurn,
      ply: Number(ply),
      gameId: String(gameId),
      rulesetId,
      stateHash,
      transcriptRoot,
      board: [...board].map(Number),
    };
  };
  const createInvitedGame = async (label) => {
    const salt = `0x${randomBytes(32).toString("hex")}`;
    const game = getAddress(await publicClient.readContract({
      address: evidence.release.factory,
      abi: factoryAbi,
      functionName: "predictGame",
      args: [white.address, black.address, salt],
    }));
    const receipt = await submit(`${label}.create`, whiteClient, {
      address: evidence.release.factory,
      abi: factoryAbi,
      functionName: "createGame",
      args: [black.address, salt, 0],
    });
    const events = parseEventLogs({
      abi: factoryAbi,
      logs: receipt.logs,
      eventName: "GameCreated",
      strict: true,
    });
    assert.equal(events.length, 1, `${label} did not emit exactly one GameCreated event`);
    assert.equal(getAddress(events[0].args.game), game);
    return { game, gameId: String(events[0].args.gameId) };
  };
  const signedMove = async (game, snapshot, raw, account) => {
    const message = {
      gameId: BigInt(snapshot.gameId),
      rulesetId: snapshot.rulesetId,
      ply: snapshot.ply,
      prevTranscriptRoot: snapshot.transcriptRoot,
      fromSquare: raw.fromSquare,
      toSquare: raw.toSquare,
      promotion: raw.promotion ?? 0,
    };
    const typedData = moveTypedData(baseSepolia.id, game, message);
    const signature = await account.signTypedData(typedData);
    assert.equal(
      await publicClient.verifyTypedData({
        address: account.address,
        ...typedData,
        signature,
      }),
      true,
    );
    return {
      ...message,
      gameId: String(message.gameId),
      nextTranscriptRoot: nextTranscriptRoot(message),
      signer: getAddress(account.address),
      signature,
    };
  };

  persistEvidence();
  console.log(`Evidence: ${evidencePath}`);

  const primary = await createInvitedGame("primary");
  evidence.games.primary = { address: primary.game, gameId: primary.gameId };
  persistEvidence();
  let primaryState = await readGame(primary.game);
  assert.equal(primaryState.status, 0);
  assert.equal(primaryState.white, getAddress(white.address));
  assert.equal(primaryState.black, getAddress(zeroAddress));
  assert.equal(primaryState.invited, getAddress(black.address));
  check("invited game created atomically", { game: primary.game });

  await expectContractRevert(
    "uninvited account cannot join an invited game",
    "Unauthorized",
    () => publicClient.simulateContract({
      address: primary.game,
      abi: gameAbi,
      functionName: "join",
      account: relayer.address,
    }),
    evidence.checks,
  );
  await expectContractRevert(
    "non-creator cannot cancel a waiting game",
    "Unauthorized",
    () => publicClient.simulateContract({
      address: primary.game,
      abi: gameAbi,
      functionName: "cancel",
      account: black.address,
    }),
    evidence.checks,
  );

  await submit("primary.join", blackClient, {
    address: primary.game,
    abi: gameAbi,
    functionName: "join",
  });
  primaryState = await readGame(primary.game);
  assert.equal(primaryState.status, 1);
  assert.equal(primaryState.black, getAddress(black.address));
  assert.equal(primaryState.ply, 0);
  assert.equal(primaryState.whiteTurn, true);
  check("invited black player joined", { game: primary.game });

  await expectContractRevert(
    "wrong-turn player cannot submit a live move",
    "Unauthorized",
    () => publicClient.simulateContract({
      address: primary.game,
      abi: gameAbi,
      functionName: "play",
      args: [12, 28, 0],
      account: black.address,
    }),
    evidence.checks,
  );
  await expectContractRevert(
    "non-player cannot claim a match record",
    "NotPlayer",
    () => publicClient.simulateContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "claim",
      args: [primary.game],
      account: relayer.address,
    }),
    evidence.checks,
  );

  const whiteTokenId = matchRecordTokenId(
    baseSepolia.id,
    primary.game,
    white.address,
  );
  const blackTokenId = matchRecordTokenId(
    baseSepolia.id,
    primary.game,
    black.address,
  );
  await submit("primary.claim-white-record", whiteClient, {
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "claim",
    args: [primary.game],
  });
  await submit("primary.claim-black-record", blackClient, {
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "claim",
    args: [primary.game],
  });
  const recordOwners = await Promise.all([whiteTokenId, blackTokenId].map(
    (tokenId) => publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "ownerOf",
      args: [tokenId],
    }),
  ));
  assert.deepEqual(
    recordOwners.map((address) => getAddress(address)),
    [getAddress(white.address), getAddress(black.address)],
  );
  const recordLocks = await Promise.all([whiteTokenId, blackTokenId].map(
    (tokenId) => publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "locked",
      args: [tokenId],
    }),
  ));
  assert.deepEqual(recordLocks, [true, true]);
  await expectContractRevert(
    "soulbound record transfer rejected",
    "Soulbound",
    () => publicClient.simulateContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "transferFrom",
      args: [white.address, black.address, whiteTokenId],
      account: white.address,
    }),
    evidence.checks,
  );
  const initialMetadata = metadataSnapshot(await publicClient.readContract({
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "tokenURI",
    args: [whiteTokenId],
  }));
  const initialBlackMetadata = metadataSnapshot(await publicClient.readContract({
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "tokenURI",
    args: [blackTokenId],
  }));
  assertMetadata(initialMetadata, {
    gameId: primary.gameId,
    player: white.address,
    ply: 0,
    state: primaryState.status,
    transcriptRoot: primaryState.transcriptRoot,
  });
  assertMetadata(initialBlackMetadata, {
    gameId: primary.gameId,
    player: black.address,
    ply: 0,
    state: primaryState.status,
    transcriptRoot: primaryState.transcriptRoot,
  });
  assert.notEqual(initialMetadata.tokenUriHash, initialBlackMetadata.tokenUriHash);
  check("both dynamic soulbound records claimed", {
    whiteTokenId: whiteTokenId.toString(),
    blackTokenId: blackTokenId.toString(),
    initialMetadata,
    initialBlackMetadata,
  });

  const expectedLiveRoot = nextTranscriptRoot({
    gameId: BigInt(primaryState.gameId),
    rulesetId: primaryState.rulesetId,
    ply: primaryState.ply,
    prevTranscriptRoot: primaryState.transcriptRoot,
    fromSquare: 52,
    toSquare: 36,
    promotion: 0,
  });
  await submit("primary.live-white-e2-e4", whiteClient, {
    address: primary.game,
    abi: gameAbi,
    functionName: "play",
    args: [52, 36, 0],
  });
  primaryState = await readGame(primary.game);
  assert.equal(primaryState.ply, 1);
  assert.equal(primaryState.whiteTurn, false);
  assert.equal(primaryState.transcriptRoot, expectedLiveRoot);
  assert.equal(primaryState.board[52], 0);
  assert.equal(primaryState.board[36], 1);
  const liveMetadata = metadataSnapshot(await publicClient.readContract({
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "tokenURI",
    args: [whiteTokenId],
  }));
  assertMetadata(liveMetadata, {
    gameId: primary.gameId,
    player: white.address,
    ply: 1,
    state: primaryState.status,
    transcriptRoot: primaryState.transcriptRoot,
  });
  assert.notEqual(liveMetadata.svgHash, initialMetadata.svgHash);
  check("live move advanced state and dynamic SVG", { metadata: liveMetadata });

  const blackOfflineMove = await signedMove(
    primary.game,
    primaryState,
    { fromSquare: 12, toSquare: 28 },
    black,
  );
  const blackTranscript = parseTranscriptJson(JSON.stringify({
    schema: TRANSCRIPT_SCHEMA,
    chainId: baseSepolia.id,
    game: primary.game,
    moves: [blackOfflineMove],
  }), { chainId: baseSepolia.id, game: primary.game });
  const whiteImported = parseTranscriptJson(
    JSON.stringify(blackTranscript),
    { chainId: baseSepolia.id, game: primary.game },
  );
  const whiteOfflineMove = await signedMove(
    primary.game,
    {
      ...primaryState,
      ply: primaryState.ply + 1,
      transcriptRoot: blackOfflineMove.nextTranscriptRoot,
    },
    { fromSquare: 62, toSquare: 45 },
    white,
  );
  const whiteTranscript = parseTranscriptJson(JSON.stringify({
    ...whiteImported,
    moves: [...whiteImported.moves, whiteOfflineMove],
  }), { chainId: baseSepolia.id, game: primary.game });
  const mergedTranscript = mergeTranscripts(
    blackTranscript,
    parseTranscriptJson(JSON.stringify(whiteTranscript), {
      chainId: baseSepolia.id,
      game: primary.game,
    }),
  );
  assert.equal(
    validateTranscriptContinuation(mergedTranscript.moves, primaryState),
    whiteOfflineMove.nextTranscriptRoot,
  );
  const [previewStateHashes, previewRoots] = await publicClient.readContract({
    address: primary.game,
    abi: gameAbi,
    functionName: "previewMoves",
    args: [
      mergedTranscript.moves.map((move) => Number(move.fromSquare)),
      mergedTranscript.moves.map((move) => Number(move.toSquare)),
      mergedTranscript.moves.map((move) => Number(move.promotion)),
    ],
  });
  assert.deepEqual(
    [...previewRoots],
    mergedTranscript.moves.map((move) => move.nextTranscriptRoot),
  );
  const checkpointMoves = mergedTranscript.moves.map(checkpointMove);
  const checkpointSignatures = mergedTranscript.moves.map(
    (move) => move.signature,
  );
  const swappedSignatures = [...checkpointSignatures].reverse();
  await expectContractRevert(
    "checkpoint rejects signatures assigned to the wrong player",
    "InvalidAuthorization",
    () => publicClient.simulateContract({
      address: primary.game,
      abi: gameAbi,
      functionName: "checkpoint",
      args: [checkpointMoves, swappedSignatures],
      account: relayer.address,
    }),
    evidence.checks,
  );
  const wrongDomainSignature = await black.signTypedData(
    moveTypedData(
      baseSepolia.id,
      evidence.release.factory,
      checkpointMoves[0],
    ),
  );
  await expectContractRevert(
    "checkpoint rejects a signature from the wrong EIP-712 domain",
    "InvalidAuthorization",
    () => publicClient.simulateContract({
      address: primary.game,
      abi: gameAbi,
      functionName: "checkpoint",
      args: [[checkpointMoves[0]], [wrongDomainSignature]],
      account: relayer.address,
    }),
    evidence.checks,
  );
  check("offline transcript exported, imported, merged, and previewed", {
    plies: mergedTranscript.moves.map((move) => Number(move.ply)),
    finalTranscriptRoot: whiteOfflineMove.nextTranscriptRoot,
  });

  const checkpointStartStateHash = primaryState.stateHash;
  const checkpointReceipt = await submit(
    "primary.checkpoint-two-offline-moves",
    relayerClient,
    {
      address: primary.game,
      abi: gameAbi,
      functionName: "checkpoint",
      args: [checkpointMoves, checkpointSignatures],
    },
  );
  const checkpointEvents = parseEventLogs({
    abi: gameAbi,
    logs: checkpointReceipt.logs,
    eventName: "MovePlayed",
    strict: true,
  });
  assert.equal(checkpointEvents.length, 2);
  for (let index = 0; index < checkpointEvents.length; index += 1) {
    const event = checkpointEvents[index];
    const move = mergedTranscript.moves[index];
    assert.equal(Number(event.args.ply), Number(move.ply));
    assert.equal(getAddress(event.args.player), getAddress(move.signer));
    assert.equal(Number(event.args.fromSquare), Number(move.fromSquare));
    assert.equal(Number(event.args.toSquare), Number(move.toSquare));
    assert.equal(Number(event.args.promotion), Number(move.promotion));
    assert.equal(
      event.args.prevStateHash,
      index === 0 ? checkpointStartStateHash : previewStateHashes[index - 1],
    );
    assert.equal(event.args.stateHash, previewStateHashes[index]);
    assert.equal(event.args.transcriptRoot, previewRoots[index]);
    assert.equal(event.args.checkpointed, true);
  }
  primaryState = await readGame(primary.game);
  assert.equal(primaryState.ply, 3);
  assert.equal(primaryState.transcriptRoot, whiteOfflineMove.nextTranscriptRoot);
  assert.equal(primaryState.stateHash, previewStateHashes.at(-1));
  assert.equal(primaryState.board[12], 0);
  assert.equal(primaryState.board[28], -1);
  assert.equal(primaryState.board[62], 0);
  assert.equal(primaryState.board[45], 2);
  await expectContractRevert(
    "checkpoint rejects replay after canonical state advances",
    "InvalidAuthorization",
    () => publicClient.simulateContract({
      address: primary.game,
      abi: gameAbi,
      functionName: "checkpoint",
      args: [checkpointMoves, checkpointSignatures],
      account: relayer.address,
    }),
    evidence.checks,
  );
  const checkpointMetadata = metadataSnapshot(await publicClient.readContract({
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "tokenURI",
    args: [whiteTokenId],
  }));
  assertMetadata(checkpointMetadata, {
    gameId: primary.gameId,
    player: white.address,
    ply: 3,
    state: primaryState.status,
    transcriptRoot: primaryState.transcriptRoot,
  });
  assert.notEqual(checkpointMetadata.svgHash, liveMetadata.svgHash);
  check("permissionless checkpoint archived both signed moves", {
    eventCount: checkpointEvents.length,
    metadata: checkpointMetadata,
  });

  await submit("primary.return-live-black-b8-c6", blackClient, {
    address: primary.game,
    abi: gameAbi,
    functionName: "play",
    args: [1, 18, 0],
  });
  primaryState = await readGame(primary.game);
  assert.equal(primaryState.ply, 4);
  assert.equal(primaryState.whiteTurn, true);
  const returnedLiveMetadata = metadataSnapshot(await publicClient.readContract({
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "tokenURI",
    args: [whiteTokenId],
  }));
  assertMetadata(returnedLiveMetadata, {
    gameId: primary.gameId,
    player: white.address,
    ply: 4,
    state: primaryState.status,
    transcriptRoot: primaryState.transcriptRoot,
  });
  assert.notEqual(returnedLiveMetadata.svgHash, checkpointMetadata.svgHash);
  check("game returned from checkpointed to live play", {
    metadata: returnedLiveMetadata,
  });

  await submit("primary.black-resigns", blackClient, {
    address: primary.game,
    abi: gameAbi,
    functionName: "resign",
  });
  primaryState = await readGame(primary.game);
  assert.equal(primaryState.status, 3);
  const terminalMetadata = metadataSnapshot(await publicClient.readContract({
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "tokenURI",
    args: [whiteTokenId],
  }));
  assertMetadata(terminalMetadata, {
    gameId: primary.gameId,
    player: white.address,
    ply: primaryState.ply,
    state: 3,
    transcriptRoot: primaryState.transcriptRoot,
  });
  await expectContractRevert(
    "terminal game rejects further play",
    "InvalidState",
    () => publicClient.simulateContract({
      address: primary.game,
      abi: gameAbi,
      functionName: "play",
      args: [61, 25, 0],
      account: white.address,
    }),
    evidence.checks,
  );
  check("resignation completed the game irreversibly", {
    finalStatus: primaryState.status,
    terminalMetadata,
  });

  await submit("primary.burn-white-record", whiteClient, {
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "burn",
    args: [whiteTokenId],
  });
  await submit("primary.burn-black-record", blackClient, {
    address: evidence.release.record,
    abi: recordAbi,
    functionName: "burn",
    args: [blackTokenId],
  });
  await expectContractRevert(
    "burned white record no longer has an owner",
    "ERC721NonexistentToken",
    () => publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "ownerOf",
      args: [whiteTokenId],
    }),
    evidence.checks,
  );
  await expectContractRevert(
    "burned white record no longer exposes metadata",
    "ERC721NonexistentToken",
    () => publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "tokenURI",
      args: [whiteTokenId],
    }),
    evidence.checks,
  );
  await expectContractRevert(
    "burned black record no longer has an owner",
    "ERC721NonexistentToken",
    () => publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "ownerOf",
      args: [blackTokenId],
    }),
    evidence.checks,
  );
  await expectContractRevert(
    "burned black record no longer exposes metadata",
    "ERC721NonexistentToken",
    () => publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "tokenURI",
      args: [blackTokenId],
    }),
    evidence.checks,
  );
  const claimedAfterBurn = await Promise.all([
    publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "claimed",
      args: [primary.game, white.address],
    }),
    publicClient.readContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "claimed",
      args: [primary.game, black.address],
    }),
  ]);
  assert.deepEqual(claimedAfterBurn, [true, true]);
  await expectContractRevert(
    "burned record cannot be claimed again",
    "AlreadyClaimed",
    () => publicClient.simulateContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "claim",
      args: [primary.game],
      account: white.address,
    }),
    evidence.checks,
  );
  check("both optional records burned irreversibly");

  const cancelled = await createInvitedGame("cancelled");
  evidence.games.cancelled = {
    address: cancelled.game,
    gameId: cancelled.gameId,
  };
  persistEvidence();
  await submit("cancelled.cancel-before-join", whiteClient, {
    address: cancelled.game,
    abi: gameAbi,
    functionName: "cancel",
  });
  const cancelledState = await readGame(cancelled.game);
  assert.equal(cancelledState.status, 5);
  assert.equal(cancelledState.black, getAddress(zeroAddress));
  await expectContractRevert(
    "cancelled game rejects join",
    "InvalidState",
    () => publicClient.simulateContract({
      address: cancelled.game,
      abi: gameAbi,
      functionName: "join",
      account: black.address,
    }),
    evidence.checks,
  );
  await expectContractRevert(
    "cancelled unjoined game rejects record claim",
    "NotPlayer",
    () => publicClient.simulateContract({
      address: evidence.release.record,
      abi: recordAbi,
      functionName: "claim",
      args: [cancelled.game],
      account: white.address,
    }),
    evidence.checks,
  );
  check("pre-join cancellation is terminal", { game: cancelled.game });

  const [whiteBalanceAfter, blackBalanceAfter, relayerBalanceAfter] = await Promise.all([
    publicClient.getBalance({ address: white.address }),
    publicClient.getBalance({ address: black.address }),
    publicClient.getBalance({ address: relayer.address }),
  ]);
  evidence.accounts.white.balanceAfterEth = formatEther(whiteBalanceAfter);
  evidence.accounts.black.balanceAfterEth = formatEther(blackBalanceAfter);
  evidence.accounts.relayer.balanceAfterEth = formatEther(relayerBalanceAfter);
  evidence.status = "passed";
  evidence.completedAt = new Date().toISOString();
  persistEvidence();
  console.log(`Base Sepolia release acceptance passed. Evidence: ${evidencePath}`);
}

main().catch((error) => {
  const failure = redactedError(error);
  if (evidence && persistEvidence) {
    evidence.status = "failed";
    evidence.completedAt = new Date().toISOString();
    evidence.failure = failure;
    try {
      persistEvidence();
    } catch (persistError) {
      console.error(
        `Could not persist failure evidence: ${redactedError(persistError)}`,
      );
    }
  }
  console.error(`Base Sepolia release acceptance failed: ${failure}`);
  process.exitCode = 1;
});
