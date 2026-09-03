// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IQueenCheckGame {
    function gameId() external view returns (uint256);
    function whitePlayer() external view returns (address);
    function blackPlayer() external view returns (address);
    function status() external view returns (uint8);
    function ply() external view returns (uint32);
    function stateHash() external view returns (bytes32);
    function transcriptRoot() external view returns (bytes32);
    function getBoard() external view returns (int8[64] memory);
}
