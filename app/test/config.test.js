import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedChain } from '../src/lib/config.js';

test('only Base Sepolia and local development are admitted', () => {
  assert.equal(isSupportedChain(84532), true); assert.equal(isSupportedChain(31337), true);
  assert.equal(isSupportedChain(8453), false); assert.equal(isSupportedChain(1), false);
});
