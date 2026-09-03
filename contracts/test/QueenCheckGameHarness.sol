// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QueenCheckGame} from "../QueenCheckGame.sol";

/// @dev Test-only harness for reaching rule thresholds without a 100-ply fixture.
contract QueenCheckGameHarness is QueenCheckGame {
    function setHalfmoveClock(uint32 value) external {
        halfmoveClock = value;
    }
}
