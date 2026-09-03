import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, zeroAddress } from 'viem';
import { discoverGames, gameStatusGroup } from '../src/lib/game-discovery.js';

const factory = '0x1000000000000000000000000000000000000001';
const gameOne = '0x2000000000000000000000000000000000000002';
const gameTwo = '0x3000000000000000000000000000000000000003';
const whiteOne = '0x4000000000000000000000000000000000000004';
const whiteTwo = '0x5000000000000000000000000000000000000005';
const blackOne = '0x6000000000000000000000000000000000000006';

const deployment = {
  deployment: { blockNumber: 80 },
  contracts: { factory: { blockNumber: 80 } }
};

function event({ game, gameId, whitePlayer, invitedPlayer = zeroAddress, blockNumber, logIndex = 0, removed = false }) {
  return {
    args: { game, gameId: BigInt(gameId), whitePlayer, invitedPlayer },
    blockNumber: BigInt(blockNumber),
    logIndex,
    removed,
    transactionHash: `0x${String(gameId).padStart(64, '0')}`
  };
}

function client({ chainId = 84532, latestBlock = 100n, logs = [], registered = true } = {}) {
  const states = {
    [gameOne.toLowerCase()]: {
      whitePlayer: whiteOne, blackPlayer: blackOne, invitedPlayer: zeroAddress,
      status: 1, ply: 7, gameId: 1n
    },
    [gameTwo.toLowerCase()]: {
      whitePlayer: whiteTwo, blackPlayer: zeroAddress, invitedPlayer: blackOne,
      status: 0, ply: 0, gameId: 2n
    }
  };
  return {
    calls: [],
    async getChainId() { return chainId; },
    async getBlockNumber() { return latestBlock; },
    async getLogs(options) { this.calls.push(options); return typeof logs === 'function' ? logs(options) : logs; },
    async getCode({ address }) { return states[address.toLowerCase()] ? '0x6001' : '0x'; },
    async readContract({ address, functionName, args }) {
      if (address.toLowerCase() === factory.toLowerCase()) {
        if (functionName === 'nextGameId') return 3n;
        if (functionName === 'isGame') return typeof registered === 'function' ? registered(args[0]) : registered;
      }
      const state = states[address.toLowerCase()];
      if (!state || !(functionName in state)) throw new Error('Unexpected contract read');
      return state[functionName];
    }
  };
}

const verifyDeployment = async () => ({ factory, record: zeroAddress });

test('discovers verified games newest first without requesting a wallet', async () => {
  const rpc = client({
    logs: [
      event({ game: gameOne, gameId: 1, whitePlayer: whiteOne, blockNumber: 90 }),
      event({ game: gameTwo, gameId: 2, whitePlayer: whiteTwo, invitedPlayer: blackOne, blockNumber: 95 }),
      event({ game: gameOne, gameId: 1, whitePlayer: whiteOne, blockNumber: 90, removed: true })
    ]
  });
  const result = await discoverGames({
    publicClient: rpc,
    deployment,
    verifyDeployment,
    confirmations: 2n,
    blockWindow: 100n
  });

  assert.deepEqual(result.games.map((game) => game.address), [getAddress(gameTwo), getAddress(gameOne)]);
  assert.deepEqual(result.games.map((game) => game.group), ['open', 'active']);
  assert.equal(result.games[0].invited, getAddress(blackOne));
  assert.equal(result.totalCreated, '2');
  assert.equal(result.confirmedThrough, '98');
  assert.equal(result.searchTruncated, false);
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].fromBlock, 80n);
  assert.equal(rpc.calls[0].toBlock, 98n);
});

test('rejects a public RPC on the wrong chain before reading logs', async () => {
  const rpc = client({ chainId: 8453 });
  await assert.rejects(
    discoverGames({ publicClient: rpc, deployment, verifyDeployment }),
    /not connected to Base Sepolia/
  );
  assert.equal(rpc.calls.length, 0);
});

test('does not publish factory events whose game cannot be verified', async () => {
  const rpc = client({
    logs: [event({ game: gameOne, gameId: 1, whitePlayer: whiteOne, blockNumber: 90 })],
    registered: false
  });
  await assert.rejects(
    discoverGames({ publicClient: rpc, deployment, verifyDeployment, confirmations: 2n, blockWindow: 100n }),
    /could not be independently verified/
  );
});

test('scans bounded block windows backwards and stops after the requested games', async () => {
  const rpc = client({
    logs: ({ fromBlock }) => fromBlock === 91n
      ? [event({ game: gameTwo, gameId: 2, whitePlayer: whiteTwo, invitedPlayer: blackOne, blockNumber: 95 })]
      : [event({ game: gameOne, gameId: 1, whitePlayer: whiteOne, blockNumber: 85 })]
  });
  const result = await discoverGames({
    publicClient: rpc,
    deployment,
    verifyDeployment,
    confirmations: 0n,
    limit: 2,
    blockWindow: 10n
  });

  assert.deepEqual(rpc.calls.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [[91n, 100n], [81n, 90n]]);
  assert.deepEqual(result.games.map(({ gameId }) => gameId), ['2', '1']);
  assert.equal(result.hasMore, false);
});

test('bounds enrichment work even when one block window contains many games', async () => {
  const logs = Array.from({ length: 40 }, (_, index) => {
    const value = (index + 100).toString(16).padStart(40, '0');
    const player = (index + 1_000).toString(16).padStart(40, '0');
    return event({
      game: `0x${value}`,
      gameId: index + 1,
      whitePlayer: `0x${player}`,
      blockNumber: 90,
      logIndex: index
    });
  });
  let codeReads = 0;
  let gameReads = 0;
  const rpc = {
    async getChainId() { return 84532; },
    async getBlockNumber() { return 100n; },
    async getLogs({ args }) {
      const requested = new Set((Array.isArray(args.gameId) ? args.gameId : [args.gameId]).map(String));
      return logs.filter((log) => requested.has(String(log.args.gameId)));
    },
    async getCode() { codeReads += 1; return '0x6001'; },
    async readContract({ address, functionName, args, blockNumber }) {
      if (address.toLowerCase() === factory.toLowerCase()) {
        if (functionName === 'nextGameId') {
          assert.equal(blockNumber, 98n);
          return 41n;
        }
        if (functionName === 'isGame') return true;
      }
      gameReads += 1;
      const source = logs.find((log) => log.args.game.toLowerCase() === address.toLowerCase());
      return {
        whitePlayer: source.args.whitePlayer,
        blackPlayer: zeroAddress,
        invitedPlayer: zeroAddress,
        status: 0,
        ply: 0,
        gameId: source.args.gameId
      }[functionName];
    }
  };

  const result = await discoverGames({
    publicClient: rpc,
    deployment,
    verifyDeployment,
    confirmations: 2n,
    blockWindow: 100n,
    limit: 24
  });
  assert.equal(result.games.length, 24);
  assert.equal(codeReads, 27);
  assert.equal(gameReads, 27 * 6);
  assert.equal(result.hasMore, true);
});

test('rejects an RPC response that ignores the bounded indexed game filter', async () => {
  const logs = Array.from({ length: 40 }, (_, index) => event({
    game: `0x${(index + 100).toString(16).padStart(40, '0')}`,
    gameId: index + 1,
    whitePlayer: `0x${(index + 1_000).toString(16).padStart(40, '0')}`,
    blockNumber: 90,
    logIndex: index
  }));
  let codeReads = 0;
  const rpc = {
    async getChainId() { return 84532; },
    async getBlockNumber() { return 100n; },
    async getLogs() { return logs; },
    async getCode() { codeReads += 1; return '0x6001'; },
    async readContract({ address, functionName }) {
      if (address.toLowerCase() === factory.toLowerCase() && functionName === 'nextGameId') return 41n;
      throw new Error('Per-game reads must not run for an invalid log response');
    }
  };

  await assert.rejects(
    discoverGames({ publicClient: rpc, deployment, verifyDeployment, confirmations: 2n, blockWindow: 100n }),
    /outside the requested game IDs/
  );
  assert.equal(codeReads, 0);
});

test('reports when the bounded block search cannot reach older known games', async () => {
  const rpc = client({ latestBlock: 1_000n, logs: [] });
  const result = await discoverGames({
    publicClient: rpc,
    deployment: { contracts: { factory: { blockNumber: 0 } } },
    verifyDeployment,
    confirmations: 0n,
    blockWindow: 10n
  });
  assert.equal(rpc.calls.length, 20);
  assert.equal(result.totalCreated, '2');
  assert.deepEqual(result.games, []);
  assert.equal(result.searchTruncated, true);
});

test('maps every terminal contract state to the completed group', () => {
  assert.equal(gameStatusGroup(0), 'open');
  assert.equal(gameStatusGroup(1), 'active');
  for (const status of [2, 3, 4, 5]) assert.equal(gameStatusGroup(status), 'completed');
});
