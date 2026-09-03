import { getAddress, isAddress, zeroAddress } from 'viem';
import { assertTrustedDeployment } from './deployment.js';
import { factoryAbi, gameAbi } from './contracts/abi.js';
import baseSepoliaDeployment from './deployments/base-sepolia.json' with { type: 'json' };
import { getPublicClient, PUBLIC_CHAIN_ID } from './public-client.js';

export const GAME_STATUS_LABELS = Object.freeze([
  'Open',
  'Active',
  'Draw',
  'White won',
  'Black won',
  'Cancelled'
]);

export const DEFAULT_CONFIRMATIONS = 12n;
export const DEFAULT_GAME_LIMIT = 24;
export const DEFAULT_BLOCK_WINDOW = 10_000n;
export const DEFAULT_GAME_CONCURRENCY = 3;
export const DIRECTORY_CACHE_MS = 30_000;
export const MAX_REJECTED_GAME_EVENTS = 3;
export const MAX_LOG_WINDOWS = 20;

let cachedDirectory = null;
let cachedAt = 0;
let directoryRequest = null;

const gameCreatedEvent = factoryAbi.find(
  (item) => item.type === 'event' && item.name === 'GameCreated'
);

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function deploymentBlock(deployment) {
  const value = deployment?.contracts?.factory?.blockNumber ?? deployment?.deployment?.blockNumber;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('The factory deployment block is invalid.');
  return BigInt(value);
}

function logKey(log) {
  if (log.transactionHash != null && log.logIndex != null) return `${log.transactionHash}:${log.logIndex}`;
  return `${log.blockNumber ?? ''}:${log.args?.game ?? ''}:${log.args?.gameId ?? ''}`;
}

function compareLogsNewestFirst(left, right) {
  const blockOrder = (right.blockNumber ?? 0n) > (left.blockNumber ?? 0n)
    ? 1
    : (right.blockNumber ?? 0n) < (left.blockNumber ?? 0n) ? -1 : 0;
  if (blockOrder) return blockOrder;
  return Number(right.logIndex ?? 0) - Number(left.logIndex ?? 0);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index]);
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function gameStatusGroup(status) {
  if (Number(status) === 0) return 'open';
  if (Number(status) === 1) return 'active';
  return 'completed';
}

async function loadGameSummary(publicClient, factory, log) {
  const eventGame = log.args?.game;
  const eventWhite = log.args?.whitePlayer;
  const eventInvited = log.args?.invitedPlayer;
  const eventGameId = log.args?.gameId;
  if (![eventGame, eventWhite, eventInvited].every(isAddress) || eventGameId == null) return null;

  const address = getAddress(eventGame);
  const [code, registered, white, black, invited, status, ply, gameId] = await Promise.all([
    publicClient.getCode({ address }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'isGame', args: [address] }),
    publicClient.readContract({ address, abi: gameAbi, functionName: 'whitePlayer' }),
    publicClient.readContract({ address, abi: gameAbi, functionName: 'blackPlayer' }),
    publicClient.readContract({ address, abi: gameAbi, functionName: 'invitedPlayer' }),
    publicClient.readContract({ address, abi: gameAbi, functionName: 'status' }),
    publicClient.readContract({ address, abi: gameAbi, functionName: 'ply' }),
    publicClient.readContract({ address, abi: gameAbi, functionName: 'gameId' })
  ]);

  const numericStatus = Number(status);
  if (
    !registered || !code || code === '0x' ||
    !Number.isInteger(numericStatus) || numericStatus < 0 || numericStatus >= GAME_STATUS_LABELS.length ||
    BigInt(gameId) !== BigInt(eventGameId) ||
    getAddress(white) !== getAddress(eventWhite) ||
    getAddress(invited) !== getAddress(eventInvited)
  ) return null;

  return {
    address,
    gameId: String(gameId),
    white: getAddress(white),
    black: getAddress(black),
    invited: getAddress(invited),
    status: numericStatus,
    statusLabel: GAME_STATUS_LABELS[numericStatus],
    group: gameStatusGroup(numericStatus),
    ply: Number(ply),
    createdBlock: String(log.blockNumber ?? ''),
    transactionHash: log.transactionHash ?? '',
    hasBlackPlayer: getAddress(black) !== zeroAddress
  };
}

export async function discoverGames({
  publicClient = getPublicClient(),
  deployment = baseSepoliaDeployment,
  verifyDeployment = (client) => assertTrustedDeployment(client, PUBLIC_CHAIN_ID),
  confirmations = DEFAULT_CONFIRMATIONS,
  limit = DEFAULT_GAME_LIMIT,
  blockWindow = DEFAULT_BLOCK_WINDOW,
  concurrency = DEFAULT_GAME_CONCURRENCY
} = {}) {
  requirePositiveInteger(limit, 'Game limit');
  requirePositiveInteger(concurrency, 'Game concurrency');
  if (limit > 25) throw new Error('Game limit cannot exceed 25.');
  if (concurrency > 3) throw new Error('Game concurrency cannot exceed 3.');
  if (typeof confirmations !== 'bigint' || confirmations < 0n) throw new Error('Confirmations must be a non-negative bigint.');
  if (typeof blockWindow !== 'bigint' || blockWindow <= 0n) throw new Error('Block window must be a positive bigint.');
  if (blockWindow > 10_000n) throw new Error('Block window cannot exceed 10,000 blocks.');

  const chainId = Number(await publicClient.getChainId());
  if (chainId !== PUBLIC_CHAIN_ID) throw new Error('The public RPC is not connected to Base Sepolia.');
  const trusted = await verifyDeployment(publicClient);
  const factory = getAddress(trusted.factory);
  const firstBlock = deploymentBlock(deployment);
  const latestBlock = await publicClient.getBlockNumber();
  const confirmedThrough = latestBlock > confirmations ? latestBlock - confirmations : 0n;
  if (confirmedThrough < firstBlock) {
    return { games: [], totalCreated: '0', confirmedThrough: String(confirmedThrough), hasMore: false, searchTruncated: false };
  }
  const rawNextGameId = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'nextGameId',
    blockNumber: confirmedThrough
  });
  const totalCreated = BigInt(rawNextGameId) > 0n ? BigInt(rawNextGameId) - 1n : 0n;
  if (totalCreated === 0n) {
    return { games: [], totalCreated: '0', confirmedThrough: String(confirmedThrough), hasMore: false, searchTruncated: false };
  }

  const requestedCount = Number(
    totalCreated < BigInt(limit + MAX_REJECTED_GAME_EVENTS)
      ? totalCreated
      : BigInt(limit + MAX_REJECTED_GAME_EVENTS)
  );
  const requestedIds = Array.from({ length: requestedCount }, (_, index) => totalCreated - BigInt(index));
  const requestedIdSet = new Set(requestedIds.map(String));
  const seenLogs = new Set();
  const seenEventIds = new Set();
  const candidates = [];
  let upper = confirmedThrough;
  let reachedDeploymentBlock = false;

  for (let window = 0; window < MAX_LOG_WINDOWS && upper >= firstBlock && candidates.length < requestedCount; window += 1) {
    const lower = upper - firstBlock + 1n > blockWindow ? upper - blockWindow + 1n : firstBlock;
    const logs = await publicClient.getLogs({
      address: factory,
      event: gameCreatedEvent,
      args: { gameId: requestedIds.length === 1 ? requestedIds[0] : requestedIds },
      fromBlock: lower,
      toBlock: upper,
      strict: true
    });

    for (const log of logs.filter((item) => !item.removed)) {
      const key = logKey(log);
      if (seenLogs.has(key)) continue;
      seenLogs.add(key);
      const eventId = log.args?.gameId;
      if (eventId == null || !requestedIdSet.has(String(eventId))) {
        throw new Error('The public RPC returned an event outside the requested game IDs.');
      }
      if (seenEventIds.has(String(eventId))) {
        throw new Error('The public RPC returned duplicate events for one game ID.');
      }
      seenEventIds.add(String(eventId));
      candidates.push(log);
      if (candidates.length > requestedCount) {
        throw new Error('The public RPC returned more game events than requested.');
      }
    }

    if (lower === firstBlock) {
      reachedDeploymentBlock = true;
      break;
    }
    upper = lower - 1n;
  }

  candidates.sort(compareLogsNewestFirst);
  const summaries = await mapWithConcurrency(candidates, concurrency, (log) => loadGameSummary(publicClient, factory, log));
  const rejectedSummaries = summaries.filter((summary) => !summary).length;
  const games = summaries.filter(Boolean).slice(0, limit);
  if (!games.length && candidates.length && rejectedSummaries === candidates.length) {
    throw new Error('The public RPC returned match events that could not be independently verified.');
  }

  return {
    games,
    totalCreated: String(totalCreated),
    confirmedThrough: String(confirmedThrough),
    hasMore: BigInt(games.length) < totalCreated,
    searchTruncated: !reachedDeploymentBlock && candidates.length < requestedCount
  };
}

export async function loadPublicGameDirectory({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedDirectory && now - cachedAt < DIRECTORY_CACHE_MS) return cachedDirectory;
  if (!force && directoryRequest) return directoryRequest;

  const request = discoverGames();
  directoryRequest = request;
  try {
    const result = await request;
    cachedDirectory = result;
    cachedAt = Date.now();
    return result;
  } finally {
    if (directoryRequest === request) directoryRequest = null;
  }
}
