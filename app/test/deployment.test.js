import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, keccak256 } from 'viem';
import { verifyManifestDeployment } from '../src/lib/deployment.js';
import {
  assertRuntimeMatchesArtifact,
  normalizeRuntimeBytecode
} from '../../scripts/production-artifacts.mjs';

const addresses = {
  factory: '0x1000000000000000000000000000000000000001',
  gameImplementation: '0x2000000000000000000000000000000000000002',
  rulesEngine: '0x3000000000000000000000000000000000000003',
  renderer: '0x4000000000000000000000000000000000000004',
  record: '0x5000000000000000000000000000000000000005'
};
const bytecodes = {
  factory: '0x6001', gameImplementation: '0x6002', rulesEngine: '0x6003',
  renderer: '0x6004', record: '0x6005'
};

function fixture() {
  return {
    schemaVersion: 1,
    chainId: 84532,
    status: 'deployed',
    contracts: Object.fromEntries(Object.keys(addresses).map((name) => [name, {
      address: addresses[name],
      runtimeCodeHash: keccak256(bytecodes[name]),
      sourceVerification: 'exact_match'
    }]))
  };
}

function publicClient(overrides = {}) {
  const namesByAddress = new Map(Object.entries(addresses).map(([name, address]) => [address.toLowerCase(), name]));
  return {
    async getCode({ address }) {
      const name = namesByAddress.get(address.toLowerCase());
      return overrides[name] ?? bytecodes[name];
    },
    async readContract({ address, functionName }) {
      const name = namesByAddress.get(address.toLowerCase());
      if (name === 'factory') {
        return {
          implementation: addresses.gameImplementation,
          rules: addresses.rulesEngine,
          renderer: addresses.renderer,
          record: addresses.record
        }[functionName];
      }
      if (name === 'record') {
        return { factory: addresses.factory, renderer: addresses.renderer }[functionName];
      }
      throw new Error('Unexpected contract read');
    }
  };
}

test('verified deployment requires every code hash and immutable relationship', async () => {
  assert.deepEqual(await verifyManifestDeployment(publicClient(), fixture()), {
    factory: getAddress(addresses.factory),
    record: getAddress(addresses.record)
  });
});

test('verified deployment rejects a look-alike component', async () => {
  await assert.rejects(
    verifyManifestDeployment(publicClient({ rulesEngine: '0x6006' }), fixture()),
    /rulesEngine bytecode does not match/
  );
});

test('release attestation rejects bytecode from a different source build', () => {
  const currentBytecode = '0x600160026003';
  const immutableRanges = [{ start: 2, length: 1 }];
  const artifact = {
    immutableRanges,
    normalizedRuntimeBytecode: normalizeRuntimeBytecode(currentBytecode, immutableRanges)
  };

  assert.doesNotThrow(() =>
    assertRuntimeMatchesArtifact('0x6001ff026003', artifact, 'fixture')
  );
  assert.throws(
    () => assertRuntimeMatchesArtifact('0x6101ff026003', artifact, 'fixture'),
    /was not produced by the current production build/
  );
});
