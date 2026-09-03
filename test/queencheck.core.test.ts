import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

const MOVE_TYPES = { MoveAuthorization: [
  { name: "gameId", type: "uint256" },
  { name: "rulesetId", type: "bytes32" },
  { name: "ply", type: "uint32" },
  { name: "prevTranscriptRoot", type: "bytes32" },
  { name: "fromSquare", type: "uint8" },
  { name: "toSquare", type: "uint8" },
  { name: "promotion", type: "uint8" },
] } as const;
const DRAW_TYPES = { DrawAgreement: [
  { name: "gameId", type: "uint256" },
  { name: "rulesetId", type: "bytes32" },
  { name: "ply", type: "uint32" },
  { name: "stateHash", type: "bytes32" },
  { name: "transcriptRoot", type: "bytes32" },
] } as const;
const MOVE_TYPEHASH = keccak256(stringToHex(
  "MoveAuthorization(uint256 gameId,bytes32 rulesetId,uint32 ply,bytes32 prevTranscriptRoot,uint8 fromSquare,uint8 toSquare,uint8 promotion)",
));
type RawMove = readonly [number, number, number?];
type Authorization = {
  gameId: bigint; rulesetId: Hex; ply: number; prevTranscriptRoot: Hex;
  fromSquare: number; toSquare: number; promotion: number;
};

describe("QueenCheck protocol", { concurrency: false }, async () => {
  const { viem, networkHelpers } = await network.create();
  const client = await viem.getPublicClient();
  const [white, black, relayer, outsider] = await viem.getWalletClients();
  let saltCounter = 0n;
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const salt = () => `0x${(++saltCounter).toString(16).padStart(64, "0")}` as Hex;

  async function deploySystem() {
    const rules = await viem.deployContract("ChessRulesEngine");
    const implementation = await viem.deployContract("QueenCheckGame");
    const renderer = await viem.deployContract("QueenCheckRenderer");
    const factory = await viem.deployContract("QueenCheckFactory", [
      implementation.address, rules.address, renderer.address,
    ]);
    const record = await viem.getContractAt("QueenCheckRecord", await factory.read.record());
    return { rules, implementation, renderer, factory, record };
  }

  async function deployHarnessSystem() {
    const rules = await viem.deployContract("ChessRulesEngine");
    const implementation = await viem.deployContract("QueenCheckGameHarness");
    const renderer = await viem.deployContract("QueenCheckRenderer");
    const factory = await viem.deployContract("QueenCheckFactory", [
      implementation.address, rules.address, renderer.address,
    ]);
    const record = await viem.getContractAt("QueenCheckRecord", await factory.read.record());
    return { rules, implementation, renderer, factory, record };
  }

  async function createGame(system: { factory: any }, opponent: Address = black.account.address, timeout = 0) {
    const userSalt = salt();
    const predicted = await system.factory.read.predictGame([white.account.address, opponent, userSalt]);
    await system.factory.write.createGame([opponent, userSalt, timeout], { account: white.account });
    return { game: await viem.getContractAt("QueenCheckGame", predicted), userSalt };
  }

  async function activeGame(timeout = 0) {
    const system = await deploySystem();
    const { game } = await createGame(system, black.account.address, timeout);
    await game.write.join({ account: black.account });
    return { ...system, game };
  }

  async function playSequence(game: any, moves: readonly RawMove[]) {
    for (let i = 0; i < moves.length; i++) {
      await game.write.play([moves[i][0], moves[i][1], moves[i][2] ?? 0], {
        account: i % 2 === 0 ? white.account : black.account,
      });
    }
  }

  function auth(gameId: bigint, rulesetId: Hex, ply: number, root: Hex, move: RawMove): Authorization {
    return { gameId, rulesetId, ply, prevTranscriptRoot: root,
      fromSquare: move[0], toSquare: move[1], promotion: move[2] ?? 0 };
  }
  function structHash(move: Authorization): Hex {
    return keccak256(encodeAbiParameters(
      parseAbiParameters("bytes32,uint256,bytes32,uint32,bytes32,uint8,uint8,uint8"),
      [MOVE_TYPEHASH, move.gameId, move.rulesetId, move.ply, move.prevTranscriptRoot,
        move.fromSquare, move.toSquare, move.promotion],
    ));
  }
  const nextRoot = (root: Hex, move: Authorization) => keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,bytes32"), [root, structHash(move)],
  ));

  async function signedBatch(game: any, rawMoves: readonly RawMove[]) {
    const gameId = await game.read.gameId();
    const rulesetId = await game.read.RULESET_ID();
    let root = await game.read.transcriptRoot() as Hex;
    let ply = Number(await game.read.ply());
    const chainId = await client.getChainId();
    const moves: Authorization[] = [];
    const signatures: Hex[] = [];
    for (const raw of rawMoves) {
      const move = auth(gameId, rulesetId, ply, root, raw);
      const signer = ply % 2 === 0 ? white : black;
      signatures.push(await signer.signTypedData({ account: signer.account,
        domain: { name: "QueenCheck", version: "1", chainId, verifyingContract: game.address },
        types: MOVE_TYPES, primaryType: "MoveAuthorization", message: move }));
      moves.push(move);
      root = nextRoot(root, move);
      ply++;
    }
    return { moves, signatures, finalRoot: root };
  }

  async function drawSignatures(game: any) {
    const message = {
      gameId: await game.read.gameId(),
      rulesetId: await game.read.RULESET_ID(),
      ply: Number(await game.read.ply()),
      stateHash: await game.read.stateHash(),
      transcriptRoot: await game.read.transcriptRoot(),
    };
    const domain = { name: "QueenCheck", version: "1",
      chainId: await client.getChainId(), verifyingContract: game.address } as const;
    return {
      whiteSignature: await white.signTypedData({ account: white.account, domain,
        types: DRAW_TYPES, primaryType: "DrawAgreement", message }),
      blackSignature: await black.signTypedData({ account: black.account, domain,
        types: DRAW_TYPES, primaryType: "DrawAgreement", message }),
    };
  }

  it("deploys registered deterministic clones and locks the implementation", async () => {
    const system = await deploySystem();
    const { game, userSalt } = await createGame(system);
    assert.equal(getAddress(game.address), getAddress(await system.factory.read.predictGame([
      white.account.address, black.account.address, userSalt,
    ])));
    assert.equal(await system.factory.read.isGame([game.address]), true);
    assert.equal(getAddress(await game.read.factory()), getAddress(system.factory.address));
    assert.equal(await game.read.status(), 0);
    await assert.rejects(system.implementation.write.initialize([
      99n, white.account.address, black.account.address, system.rules.address, 0,
    ]));
  });

  it("rejects a deterministic salt collision without consuming a game id", async () => {
    const system = await deploySystem();
    const userSalt = salt();
    await system.factory.write.createGame([black.account.address, userSalt, 0], {
      account: white.account,
    });
    const registered = await system.factory.read.predictGame([
      white.account.address, black.account.address, userSalt,
    ]);
    assert.equal(await system.factory.read.isGame([registered]), true);
    assert.equal(await system.factory.read.nextGameId(), 2n);
    await assert.rejects(system.factory.write.createGame([
      black.account.address, userSalt, 0,
    ], { account: white.account }));
    assert.equal(await system.factory.read.nextGameId(), 2n);
  });

  it("enforces invitations, supports open join, and creator cancellation", async () => {
    const system = await deploySystem();
    const invited = await createGame(system);
    await assert.rejects(invited.game.write.join({ account: outsider.account }));
    await invited.game.write.join({ account: black.account });
    assert.equal(getAddress(await invited.game.read.blackPlayer()), getAddress(black.account.address));
    const open = await createGame(system, zero);
    await open.game.write.join({ account: outsider.account });
    assert.equal(getAddress(await open.game.read.blackPlayer()), getAddress(outsider.account.address));
    const cancelled = await createGame(system);
    await assert.rejects(cancelled.game.write.cancel({ account: outsider.account }));
    await cancelled.game.write.cancel({ account: white.account });
    assert.equal(await cancelled.game.read.status(), 5);
    await assert.rejects(cancelled.game.write.join({ account: black.account }));
  });

  it("makes live play and signed checkpoint identical from the same snapshot", async () => {
    const { game } = await activeGame();
    const raw: RawMove[] = [[52, 36], [12, 28], [62, 45], [1, 18]];
    const batch = await signedBatch(game, raw);
    await assert.rejects(game.write.play([52, 36, 0], { account: black.account }));
    await assert.rejects(game.write.checkpoint([[], []]));
    const preview = await game.read.previewMoves([
      raw.map(m => m[0]), raw.map(m => m[1]), raw.map(m => m[2] ?? 0),
    ]);
    assert.equal(preview[1].at(-1), batch.finalRoot);
    const snapshot = await networkHelpers.takeSnapshot();
    await playSequence(game, raw);
    const live = { board: await game.read.getBoard(), state: await game.read.stateHash(),
      root: await game.read.transcriptRoot(), ply: await game.read.ply() };
    await snapshot.restore();
    await game.write.checkpoint([batch.moves, batch.signatures], { account: relayer.account });
    assert.deepEqual(await game.read.getBoard(), live.board);
    assert.equal(await game.read.stateHash(), live.state);
    assert.equal(await game.read.transcriptRoot(), live.root);
    assert.equal(await game.read.transcriptRoot(), batch.finalRoot);
    assert.equal(await game.read.ply(), live.ply);
  });

  it("accepts a full 16-move checkpoint and rejects 17 moves atomically", async () => {
    const { game } = await activeGame();
    const opening: RawMove[] = [
      [52, 36], [12, 28], [62, 45], [1, 18],
      [61, 25], [8, 16], [25, 32], [6, 21],
      [60, 62], [5, 12], [61, 60], [9, 25],
      [32, 41], [11, 19], [50, 42], [4, 6],
    ];
    const accepted = await signedBatch(game, opening);
    const rejected = await signedBatch(game, [...opening, [51, 35]]);
    const snapshot = await networkHelpers.takeSnapshot();
    const checkpointHash = await game.write.checkpoint([accepted.moves, accepted.signatures], {
      account: relayer.account,
    });
    const checkpointReceipt = await client.waitForTransactionReceipt({ hash: checkpointHash });
    assert.ok(checkpointReceipt.gasUsed < 12_000_000n);
    assert.equal(await game.read.ply(), 16);
    assert.equal(await game.read.status(), 1);

    await snapshot.restore();
    const rootBefore = await game.read.transcriptRoot();
    await assert.rejects(game.write.checkpoint([
      rejected.moves, rejected.signatures,
    ], { account: relayer.account }));
    assert.equal(await game.read.ply(), 0);
    assert.equal(await game.read.transcriptRoot(), rootBefore);
  });

  it("makes transcript events sufficient to reconstruct the root", async () => {
    const { game } = await activeGame();
    const raw: RawMove[] = [[52, 36], [12, 28], [62, 45]];
    const initial = await game.read.transcriptRoot() as Hex;
    const batch = await signedBatch(game, raw);
    const receipt = await client.waitForTransactionReceipt({ hash:
      await game.write.checkpoint([batch.moves, batch.signatures], { account: relayer.account }) });
    const events = await client.getContractEvents({ address: game.address, abi: game.abi,
      eventName: "MovePlayed", fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    assert.equal(events.length, raw.length);
    let reconstructed = initial;
    for (let i = 0; i < events.length; i++) {
      reconstructed = nextRoot(reconstructed, batch.moves[i]);
      assert.equal(events[i].args.ply, batch.moves[i].ply);
      assert.equal(events[i].args.transcriptRoot, reconstructed);
      assert.equal(events[i].args.checkpointed, true);
    }
    assert.equal(reconstructed, await game.read.transcriptRoot());
  });

  it("rejects replay, stale branches, cross-game domains, and rolls back invalid batches", async () => {
    const system = await deploySystem();
    const first = await createGame(system); const second = await createGame(system);
    await first.game.write.join({ account: black.account });
    await second.game.write.join({ account: black.account });
    const firstMove = await signedBatch(first.game, [[52, 36]]);
    await first.game.write.checkpoint([firstMove.moves, firstMove.signatures]);
    await assert.rejects(first.game.write.checkpoint([firstMove.moves, firstMove.signatures]));

    const secondMove = await signedBatch(second.game, [[52, 36]]);
    const wrongDomain = await white.signTypedData({ account: white.account,
      domain: { name: "QueenCheck", version: "1", chainId: await client.getChainId(),
        verifyingContract: first.game.address }, types: MOVE_TYPES,
      primaryType: "MoveAuthorization", message: secondMove.moves[0] });
    await assert.rejects(second.game.write.checkpoint([secondMove.moves, [wrongDomain]]));

    const two = await signedBatch(second.game, [[52, 36], [12, 28]]);
    const invalid = [...two.signatures]; invalid[1] = invalid[0];
    const rootBefore = await second.game.read.transcriptRoot();
    await assert.rejects(second.game.write.checkpoint([two.moves, invalid]));
    assert.equal(await second.game.read.ply(), 0);
    assert.equal(await second.game.read.transcriptRoot(), rootBefore);
    const stale = { ...two.moves[0], prevTranscriptRoot: `0x${"11".repeat(32)}` as Hex };
    await assert.rejects(second.game.write.checkpoint([[stale], [two.signatures[0]]]));
  });

  it("accepts ERC-1271 players with EIP-712 authorization", async () => {
    const system = await deploySystem();
    const signer = await viem.deployContract("MockERC1271Signer", [white.account.address]);
    const userSalt = salt();
    await networkHelpers.setBalance(signer.address, parseEther("1"));
    await networkHelpers.impersonateAccount(signer.address);
    const contractWallet = await viem.getWalletClient(signer.address);
    await system.factory.write.createGame([black.account.address, userSalt, 0], {
      account: contractWallet.account,
    });
    await networkHelpers.stopImpersonatingAccount(signer.address);
    const address = await system.factory.read.predictGame([signer.address, black.account.address, userSalt]);
    const game = await viem.getContractAt("QueenCheckGame", address);
    await game.write.join({ account: black.account });
    const move = auth(await game.read.gameId(), await game.read.RULESET_ID(), 0,
      await game.read.transcriptRoot(), [52, 36]);
    const signature = await white.signTypedData({ account: white.account,
      domain: { name: "QueenCheck", version: "1", chainId: await client.getChainId(),
        verifyingContract: game.address }, types: MOVE_TYPES,
      primaryType: "MoveAuthorization", message: move });
    await game.write.checkpoint([[move], [signature]], { account: relayer.account });
    assert.equal(await game.read.ply(), 1);
  });

  it("uses deadline plus grace and clears a pending timeout on a move", async () => {
    const { game } = await activeGame(300);
    await assert.rejects(game.write.signalTimeout({ account: black.account }));
    await networkHelpers.time.increaseTo(Number(await game.read.turnDeadline()));
    await game.write.signalTimeout({ account: black.account });
    await assert.rejects(game.write.finalizeTimeout());
    await game.write.play([52, 36, 0], { account: white.account });
    assert.equal(await game.read.timeoutFinalizeAfter(), 0n);
    assert.equal(await game.read.timeoutClaimant(), zero);
    await networkHelpers.time.increaseTo(Number(await game.read.turnDeadline()));
    await game.write.signalTimeout({ account: white.account });
    await networkHelpers.time.increaseTo(Number(await game.read.timeoutFinalizeAfter()));
    await game.write.finalizeTimeout({ account: outsider.account });
    assert.equal(await game.read.status(), 3);
  });

  it("closes the move window at the exact timeout-finalization boundary", async () => {
    const direct = await activeGame(300);
    await networkHelpers.time.increaseTo(Number(await direct.game.read.turnDeadline()));
    await direct.game.write.signalTimeout({ account: black.account });
    await networkHelpers.time.increaseTo(Number(await direct.game.read.timeoutFinalizeAfter()));
    await assert.rejects(direct.game.write.play([52, 36, 0], { account: white.account }));
    await direct.game.write.finalizeTimeout({ account: outsider.account });
    assert.equal(await direct.game.read.status(), 4);

    const checkpointed = await activeGame(300);
    const batch = await signedBatch(checkpointed.game, [[52, 36]]);
    await networkHelpers.time.increaseTo(Number(await checkpointed.game.read.turnDeadline()));
    await checkpointed.game.write.signalTimeout({ account: black.account });
    await networkHelpers.time.increaseTo(Number(await checkpointed.game.read.timeoutFinalizeAfter()));
    await assert.rejects(checkpointed.game.read.previewMoves([[52], [36], [0]]));
    await assert.rejects(checkpointed.game.write.checkpoint([
      batch.moves, batch.signatures,
    ], { account: relayer.account }));
    await checkpointed.game.write.finalizeTimeout({ account: outsider.account });
    assert.equal(await checkpointed.game.read.status(), 4);

    const resolution = await activeGame(300);
    await resolution.game.write.offerDraw({ account: black.account });
    const draw = await drawSignatures(resolution.game);
    await networkHelpers.time.increaseTo(Number(await resolution.game.read.turnDeadline()));
    await resolution.game.write.signalTimeout({ account: black.account });
    await networkHelpers.time.increaseTo(Number(await resolution.game.read.timeoutFinalizeAfter()));
    await assert.rejects(resolution.game.write.acceptDraw({ account: white.account }));
    await assert.rejects(resolution.game.write.agreeDraw([
      draw.whiteSignature, draw.blackSignature,
    ], { account: relayer.account }));
    await assert.rejects(resolution.game.write.resign({ account: white.account }));
    await resolution.game.write.finalizeTimeout({ account: outsider.account });
    assert.equal(await resolution.game.read.status(), 4);
  });

  it("clears draw offers after a move and supports acceptance", async () => {
    const first = await activeGame();
    await first.game.write.offerDraw({ account: black.account });
    await first.game.write.play([52, 36, 0], { account: white.account });
    assert.equal(await first.game.read.drawOfferer(), zero);
    await assert.rejects(first.game.write.acceptDraw({ account: white.account }));
    const second = await activeGame();
    await second.game.write.offerDraw({ account: white.account });
    await second.game.write.acceptDraw({ account: black.account });
    assert.equal(await second.game.read.status(), 2);
  });

  it("accepts current EIP-712 draw agreement and rejects replay or cross-game use", async () => {
    const system = await deploySystem();
    const first = await createGame(system);
    const second = await createGame(system);
    await first.game.write.join({ account: black.account });
    await second.game.write.join({ account: black.account });
    const signatures = await drawSignatures(first.game);

    await assert.rejects(second.game.write.agreeDraw([
      signatures.whiteSignature, signatures.blackSignature,
    ], { account: relayer.account }));
    await first.game.write.agreeDraw([
      signatures.whiteSignature, signatures.blackSignature,
    ], { account: relayer.account });
    assert.equal(await first.game.read.status(), 2);
    await assert.rejects(first.game.write.agreeDraw([
      signatures.whiteSignature, signatures.blackSignature,
    ], { account: relayer.account }));
  });

  it("allows a threefold claim and applies automatic fivefold draw", async () => {
    const knightCycle: RawMove[] = [[62, 45], [6, 21], [45, 62], [21, 6]];
    const threefold = await activeGame();
    await playSequence(threefold.game, [...knightCycle, ...knightCycle]);
    assert.equal(await threefold.game.read.status(), 1);
    await assert.rejects(threefold.game.write.claimThreefold({ account: outsider.account }));
    await assert.rejects(threefold.game.write.claimThreefold({ account: black.account }));
    await threefold.game.write.claimThreefold({ account: white.account });
    assert.equal(await threefold.game.read.status(), 2);

    const fivefold = await activeGame();
    await playSequence(fivefold.game, [
      ...knightCycle, ...knightCycle, ...knightCycle, ...knightCycle,
    ]);
    assert.equal(await fivefold.game.read.ply(), 16);
    assert.equal(await fivefold.game.read.status(), 2);
  });

  it("allows only the player to move to claim the fifty-move draw", async () => {
    const system = await deployHarnessSystem();
    const created = await createGame(system);
    await created.game.write.join({ account: black.account });
    const game = await viem.getContractAt("QueenCheckGameHarness", created.game.address);
    await game.write.setHalfmoveClock([100]);
    await assert.rejects(game.write.claimFiftyMove({ account: black.account }));
    await game.write.claimFiftyMove({ account: white.account });
    assert.equal(await game.read.status(), 2);

    const timedSystem = await deployHarnessSystem();
    const timedCreated = await createGame(timedSystem, black.account.address, 300);
    await timedCreated.game.write.join({ account: black.account });
    const timed = await viem.getContractAt("QueenCheckGameHarness", timedCreated.game.address);
    await timed.write.setHalfmoveClock([100]);
    await networkHelpers.time.increaseTo(Number(await timed.read.turnDeadline()));
    await timed.write.signalTimeout({ account: black.account });
    await networkHelpers.time.increaseTo(Number(await timed.read.timeoutFinalizeAfter()));
    await assert.rejects(timed.write.claimFiftyMove({ account: white.account }));
    await timed.write.finalizeTimeout({ account: outsider.account });
    assert.equal(await timed.read.status(), 4);
  });

  it("detects Fool's mate and refuses post-terminal moves", async () => {
    const { game } = await activeGame();
    await playSequence(game, [[53, 45], [12, 28], [54, 38], [3, 39]]);
    assert.equal(await game.read.status(), 4);
    assert.equal(await game.read.ply(), 4);
    await assert.rejects(game.write.play([48, 40, 0], { account: white.account }));
  });

  it("rolls back a checkpoint that continues beyond a terminal move", async () => {
    const { game } = await activeGame();
    const batch = await signedBatch(game, [
      [53, 45], [12, 28], [54, 38], [3, 39], [48, 40],
    ]);
    const rootBefore = await game.read.transcriptRoot();
    await assert.rejects(
      game.write.checkpoint([batch.moves, batch.signatures], { account: relayer.account }),
    );
    assert.equal(await game.read.ply(), 0);
    assert.equal(await game.read.status(), 1);
    assert.equal(await game.read.transcriptRoot(), rootBefore);
  });

  it("handles castling rights, en passant, and promotion", async () => {
    const castling = await activeGame();
    await playSequence(castling.game, [[52, 36], [12, 28], [62, 45], [1, 18],
      [61, 52], [6, 21], [60, 62]]);
    const castleBoard = await castling.game.read.getBoard();
    assert.equal(castleBoard[60], 0); assert.equal(castleBoard[61], 4); assert.equal(castleBoard[62], 6);
    assert.notEqual(Number(await castling.game.read.castlingFlags()) & 1, 0);

    const passant = await activeGame();
    await playSequence(passant.game, [[52, 36], [8, 16], [36, 28], [11, 27], [28, 19]]);
    const passantBoard = await passant.game.read.getBoard();
    assert.equal(passantBoard[19], 1); assert.equal(passantBoard[27], 0);
    assert.equal(await passant.game.read.enPassantCol(), -1);

    const promotion = await activeGame();
    await playSequence(promotion.game, [[48, 32], [9, 25], [32, 25], [15, 23],
      [25, 17], [23, 31], [17, 9], [31, 39]]);
    await assert.rejects(promotion.game.write.play([9, 0, 0], { account: white.account }));
    assert.equal(await promotion.game.read.ply(), 8);
    await promotion.game.write.play([9, 0, 5], { account: white.account });
    assert.equal((await promotion.game.read.getBoard())[0], 5);
  });

  it("invalidates only the white castling side whose rook moved and returned", async () => {
    const kingSide = await activeGame();
    await playSequence(kingSide.game, [
      [55, 39], [8, 16], [63, 47], [16, 24], [47, 63], [9, 17],
      [52, 36], [17, 25], [62, 45], [10, 18], [61, 52], [11, 19],
    ]);
    assert.equal(Number(await kingSide.game.read.castlingFlags()) & 6, 4);
    await assert.rejects(kingSide.game.write.play([60, 62, 0], {
      account: white.account,
    }));

    const queenSide = await activeGame();
    await playSequence(queenSide.game, [
      [48, 32], [15, 23], [56, 40], [23, 31], [40, 56], [14, 22],
      [51, 35], [22, 30], [57, 42], [13, 21], [58, 37], [21, 29],
      [59, 51], [12, 20],
    ]);
    assert.equal(Number(await queenSide.game.read.castlingFlags()) & 6, 2);
    await assert.rejects(queenSide.game.write.play([60, 58, 0], {
      account: white.account,
    }));
  });

  it("enforces ERC-5192 claim, soulbinding, burn, and dynamic metadata", async () => {
    const { game, record } = await activeGame();
    await record.write.claim([game.address], { account: white.account });
    const tokenId = BigInt(keccak256(encodeAbiParameters(
      parseAbiParameters("uint256,address,address"),
      [BigInt(await client.getChainId()), game.address, white.account.address],
    )));
    assert.equal(getAddress(await record.read.ownerOf([tokenId])), getAddress(white.account.address));
    assert.equal(await record.read.locked([tokenId]), true);
    assert.equal(await record.read.supportsInterface(["0xb45a3c0e"]), true);
    const before = await record.read.tokenURI([tokenId]);
    await assert.rejects(record.write.approve([black.account.address, tokenId], { account: white.account }));
    await assert.rejects(record.write.setApprovalForAll([black.account.address, true], { account: white.account }));
    await assert.rejects(record.write.transferFrom([white.account.address, black.account.address, tokenId], { account: white.account }));
    await assert.rejects(record.write.claim([game.address], { account: white.account }));
    await game.write.play([52, 36, 0], { account: white.account });
    assert.notEqual(await record.read.tokenURI([tokenId]), before);
    await assert.rejects(record.write.burn([tokenId], { account: black.account }));
    await record.write.burn([tokenId], { account: white.account });
    await assert.rejects(record.read.ownerOf([tokenId]));
    await assert.rejects(record.write.claim([game.address], { account: white.account }));
  });

  it("rejects normal ETH and remains playable after forced ETH", async () => {
    const { game } = await activeGame();
    await assert.rejects(white.sendTransaction({ to: game.address, value: parseEther("0.01") }));
    const force = await viem.deployContract("ForceEther", [], { value: parseEther("1") });
    await force.write.force([game.address]);
    assert.equal(await client.getBalance({ address: game.address }), parseEther("1"));
    await game.write.play([52, 36, 0], { account: white.account });
    assert.equal(await game.read.ply(), 1);
    assert.equal(await client.getBalance({ address: game.address }), parseEther("1"));
  });
});
