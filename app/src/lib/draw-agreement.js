import { getAddress, isAddress, isHex } from 'viem';

export const DRAW_AGREEMENT_SCHEMA = 'queencheck.draw-agreement/v1';
export const MAX_DRAW_AGREEMENT_BYTES = 16 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;
const bytes32 = (value) => typeof value === 'string' && isHex(value, { strict: true }) && value.length === 66;
const uint256String = (value) => typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) <= MAX_UINT256;

export const drawAgreementTypes = {
  DrawAgreement: [
    { name: 'gameId', type: 'uint256' },
    { name: 'rulesetId', type: 'bytes32' },
    { name: 'ply', type: 'uint32' },
    { name: 'stateHash', type: 'bytes32' },
    { name: 'transcriptRoot', type: 'bytes32' }
  ]
};

export function drawAgreementMessage(agreement) {
  return {
    gameId: BigInt(agreement.gameId), rulesetId: agreement.rulesetId, ply: Number(agreement.ply),
    stateHash: agreement.stateHash, transcriptRoot: agreement.transcriptRoot
  };
}

export function drawAgreementTypedData(chainId, game, agreement) {
  return {
    domain: { name: 'QueenCheck', version: '1', chainId: Number(chainId), verifyingContract: getAddress(game) },
    types: drawAgreementTypes,
    primaryType: 'DrawAgreement',
    message: drawAgreementMessage(agreement)
  };
}

export function createDrawAgreement(chainId, game, state) {
  return validateDrawAgreement({
    schema: DRAW_AGREEMENT_SCHEMA, chainId: Number(chainId), game: getAddress(game),
    gameId: String(state.gameId), rulesetId: state.rulesetId, ply: Number(state.ply),
    stateHash: state.stateHash, transcriptRoot: state.transcriptRoot, signatures: []
  }, { chainId, game, state });
}

export function validateDrawAgreement(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Draw agreement must be an object');
  const keys = ['schema', 'chainId', 'game', 'gameId', 'rulesetId', 'ply', 'stateHash', 'transcriptRoot', 'signatures'];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Draw agreement contains unknown fields');
  if (value.schema !== DRAW_AGREEMENT_SCHEMA || !Number.isSafeInteger(Number(value.chainId)) || Number(value.chainId) < 0 || !isAddress(value.game)) throw new Error('Invalid draw agreement header');
  if (!uint256String(value.gameId) || !bytes32(value.rulesetId) || !Number.isInteger(Number(value.ply)) || Number(value.ply) < 0 || Number(value.ply) > 0xffffffff || !bytes32(value.stateHash) || !bytes32(value.transcriptRoot)) throw new Error('Invalid draw agreement state');
  if (!Array.isArray(value.signatures) || value.signatures.length > 2) throw new Error('Invalid draw agreement signatures');
  const signatures = value.signatures.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !['signer', 'signature'].includes(key)) || !isAddress(entry.signer) || typeof entry.signature !== 'string' || !isHex(entry.signature, { strict: true }) || entry.signature.length < 2 || entry.signature.length > 8194) throw new Error('Invalid draw agreement signature');
    return { signer: getAddress(entry.signer), signature: entry.signature };
  });
  if (new Set(signatures.map((entry) => entry.signer.toLowerCase())).size !== signatures.length) throw new Error('Duplicate draw agreement signer');
  if (expected.chainId !== undefined && Number(value.chainId) !== Number(expected.chainId)) throw new Error('Draw agreement chain does not match');
  if (expected.game && getAddress(value.game) !== getAddress(expected.game)) throw new Error('Draw agreement game does not match');
  if (expected.state) {
    for (const key of ['gameId', 'rulesetId', 'stateHash', 'transcriptRoot']) {
      if (String(value[key]) !== String(expected.state[key])) throw new Error(`Draw agreement ${key} does not match current onchain state`);
    }
    if (Number(value.ply) !== Number(expected.state.ply)) throw new Error('Draw agreement ply does not match current onchain state');
  }
  return { ...value, chainId: Number(value.chainId), game: getAddress(value.game), ply: Number(value.ply), signatures };
}

export function parseDrawAgreementJson(text, expected = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_DRAW_AGREEMENT_BYTES) throw new Error('Draw agreement exceeds size limit');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Draw agreement is not valid JSON'); }
  return validateDrawAgreement(value, expected);
}

export function withDrawSignature(agreement, signer, signature) {
  const valid = validateDrawAgreement(agreement);
  const normalized = getAddress(signer);
  return validateDrawAgreement({ ...valid, signatures: [...valid.signatures.filter((entry) => entry.signer !== normalized), { signer: normalized, signature }] });
}
