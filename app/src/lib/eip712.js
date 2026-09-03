import { encodeAbiParameters, keccak256, stringToHex } from 'viem';

export const MOVE_AUTHORIZATION_TYPE = 'MoveAuthorization(uint256 gameId,bytes32 rulesetId,uint32 ply,bytes32 prevTranscriptRoot,uint8 fromSquare,uint8 toSquare,uint8 promotion)';
export const MOVE_AUTHORIZATION_TYPEHASH = keccak256(stringToHex(MOVE_AUTHORIZATION_TYPE));

export const moveAuthorizationTypes = {
  MoveAuthorization: [
    { name: 'gameId', type: 'uint256' },
    { name: 'rulesetId', type: 'bytes32' },
    { name: 'ply', type: 'uint32' },
    { name: 'prevTranscriptRoot', type: 'bytes32' },
    { name: 'fromSquare', type: 'uint8' },
    { name: 'toSquare', type: 'uint8' },
    { name: 'promotion', type: 'uint8' }
  ]
};

export function moveTypedData(chainId, game, message) {
  return {
    domain: {
      name: 'QueenCheck',
      version: '1',
      chainId: Number(chainId),
      verifyingContract: game
    },
    types: moveAuthorizationTypes,
    primaryType: 'MoveAuthorization',
    message
  };
}

export function moveStructHash(message) {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'bytes32' },
      { type: 'uint32' },
      { type: 'bytes32' },
      { type: 'uint8' },
      { type: 'uint8' },
      { type: 'uint8' }
    ],
    [
      MOVE_AUTHORIZATION_TYPEHASH,
      BigInt(message.gameId),
      message.rulesetId,
      Number(message.ply),
      message.prevTranscriptRoot,
      Number(message.fromSquare),
      Number(message.toSquare),
      Number(message.promotion)
    ]
  ));
}

export function nextTranscriptRoot(message) {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }],
    [message.prevTranscriptRoot, moveStructHash(message)]
  ));
}
