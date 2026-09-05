// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QueenCheckGame} from "../QueenCheckGame.sol";

/// @dev Test-only harness for reaching rule thresholds without a 100-ply fixture.
contract QueenCheckGameHarness is QueenCheckGame {
    function setHalfmoveClock(uint32 value) external {
        halfmoveClock = value;
    }

    /// @dev Overwrite an active board so engine terminals can be reached in one ply.
    function setTestPosition(
        int8[8][8] memory nextBoard,
        bool nextWhiteTurn,
        uint8 nextCastlingFlags,
        int8 nextEnPassantCol,
        uint8 nextEnPassantRow,
        uint32 nextHalfmoveClock
    ) external {
        if (status != Status.Active) revert InvalidState();
        uint8 foundWhite;
        uint8 foundBlack;
        uint8 nextWhiteKingRow;
        uint8 nextWhiteKingCol;
        uint8 nextBlackKingRow;
        uint8 nextBlackKingCol;
        for (uint8 row; row < 8; ++row) {
            for (uint8 col; col < 8; ++col) {
                int8 piece = nextBoard[row][col];
                if (piece == 6) {
                    nextWhiteKingRow = row;
                    nextWhiteKingCol = col;
                    ++foundWhite;
                } else if (piece == -6) {
                    nextBlackKingRow = row;
                    nextBlackKingCol = col;
                    ++foundBlack;
                }
            }
        }
        if (foundWhite != 1 || foundBlack != 1) revert InvalidMove();

        Position memory position = _loadPosition();
        position.board = nextBoard;
        position.whiteTurn = nextWhiteTurn;
        position.castlingFlags = nextCastlingFlags;
        position.enPassantCol = nextEnPassantCol;
        position.enPassantRow = nextEnPassantRow;
        position.halfmoveClock = nextHalfmoveClock;
        position.whiteKingRow = nextWhiteKingRow;
        position.whiteKingCol = nextWhiteKingCol;
        position.blackKingRow = nextBlackKingRow;
        position.blackKingCol = nextBlackKingCol;
        position.status = Status.Active;
        position.stateHash = _stateHash(position);
        _storePosition(position);
    }

    function hasInsufficientMaterial(
        int8[8][8] memory positionBoard
    ) external pure returns (bool) {
        return _hasInsufficientMaterial(positionBoard);
    }
}
