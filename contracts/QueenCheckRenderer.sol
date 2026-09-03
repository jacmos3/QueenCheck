// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IQueenCheckGame} from "./interfaces/IQueenCheckGame.sol";

/// @notice Fully onchain JSON and SVG renderer for QueenCheck match records.
contract QueenCheckRenderer {
    using Strings for uint256;

    function tokenURI(address game, address player) external view returns (string memory) {
        IQueenCheckGame registeredGame = IQueenCheckGame(game);
        string memory svg = boardSVG(game);
        string memory json = string.concat(
            '{"name":"QueenCheck #',
            registeredGame.gameId().toString(),
            '","description":"Soulbound chess record with no economic rights - queencheck.com",',
            '"attributes":[{"trait_type":"Ply","value":',
            uint256(registeredGame.ply()).toString(),
            '},{"trait_type":"State","value":',
            uint256(registeredGame.status()).toString(),
            '}],"player":"',
            Strings.toHexString(uint160(player), 20),
            '","transcript_root":"',
            Strings.toHexString(uint256(registeredGame.transcriptRoot()), 32),
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function boardSVG(address game) public view returns (string memory) {
        IQueenCheckGame registeredGame = IQueenCheckGame(game);
        int8[64] memory position = registeredGame.getBoard();
        bytes memory cells;
        for (uint8 row; row < 8; ++row) {
            for (uint8 col; col < 8; ++col) {
                string memory fill = (row + col) % 2 == 0 ? "#f0d9b5" : "#b58863";
                cells = abi.encodePacked(
                    cells,
                    '<rect x="',
                    (uint256(col) * 40).toString(),
                    '" y="',
                    (uint256(row) * 40 + 48).toString(),
                    '" width="40" height="40" fill="',
                    fill,
                    '"/>'
                );
                int8 piece = position[uint256(row) * 8 + col];
                if (piece != 0) {
                    cells = abi.encodePacked(
                        cells,
                        '<text x="',
                        (uint256(col) * 40 + 20).toString(),
                        '" y="',
                        (uint256(row) * 40 + 76).toString(),
                        '" text-anchor="middle" font-size="25" font-family="serif" fill="',
                        piece > 0 ? "#ffffff" : "#111827",
                        '">',
                        _piece(piece),
                        "</text>"
                    );
                }
            }
        }

        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="392" viewBox="0 0 320 392">',
                '<rect width="320" height="392" fill="#111827"/>',
                '<text x="16" y="28" fill="white" font-family="sans-serif" font-size="18">QueenCheck - ply ',
                uint256(registeredGame.ply()).toString(),
                "</text>",
                cells,
                '<text x="16" y="382" fill="#9ca3af" font-family="sans-serif" font-size="11">queencheck.com - ',
                Strings.toHexString(uint256(registeredGame.transcriptRoot()), 32),
                "</text></svg>"
            )
        );
    }

    function _piece(int8 piece) internal pure returns (string memory) {
        uint8 absolutePiece = piece < 0 ? uint8(-piece) : uint8(piece);
        if (absolutePiece == 1) return "P";
        if (absolutePiece == 2) return "N";
        if (absolutePiece == 3) return "B";
        if (absolutePiece == 4) return "R";
        if (absolutePiece == 5) return "Q";
        return "K";
    }
}
