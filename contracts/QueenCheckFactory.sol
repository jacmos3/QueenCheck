// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {QueenCheckGame} from "./QueenCheckGame.sol";
import {QueenCheckRecord} from "./QueenCheckRecord.sol";

/// @notice Immutable registry and deterministic minimal-proxy factory for QueenCheck games.
contract QueenCheckFactory {
    error InvalidComponent();

    address public immutable implementation;
    address public immutable rules;
    address public immutable renderer;
    QueenCheckRecord public immutable record;
    uint256 public nextGameId = 1;

    mapping(address game => bool registered) public isGame;

    event GameCreated(
        uint256 indexed gameId,
        address indexed game,
        address indexed whitePlayer,
        address invitedPlayer,
        bytes32 salt
    );

    constructor(address gameImplementation, address rulesEngine, address metadataRenderer) {
        if (
            gameImplementation.code.length == 0 ||
            rulesEngine.code.length == 0 ||
            metadataRenderer.code.length == 0
        ) revert InvalidComponent();
        implementation = gameImplementation;
        rules = rulesEngine;
        renderer = metadataRenderer;
        record = new QueenCheckRecord(address(this), metadataRenderer);
    }

    function createGame(
        address opponent,
        bytes32 userSalt,
        uint32 timeoutSeconds
    ) external returns (address game) {
        uint256 id = nextGameId++;
        bytes32 salt = _salt(msg.sender, opponent, userSalt);
        game = Clones.cloneDeterministic(implementation, salt);
        QueenCheckGame(game).initialize(id, msg.sender, opponent, rules, timeoutSeconds);
        isGame[game] = true;
        emit GameCreated(id, game, msg.sender, opponent, salt);
    }

    function predictGame(
        address creator,
        address opponent,
        bytes32 userSalt
    ) external view returns (address) {
        return Clones.predictDeterministicAddress(
            implementation,
            _salt(creator, opponent, userSalt),
            address(this)
        );
    }

    function _salt(
        address creator,
        address opponent,
        bytes32 userSalt
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, opponent, userSalt));
    }
}
