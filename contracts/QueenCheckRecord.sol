// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IQueenCheckGame} from "./interfaces/IQueenCheckGame.sol";

interface IERC5192 is IERC165 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}

interface IQueenCheckFactoryRegistry {
    function isGame(address game) external view returns (bool);
}

interface IQueenCheckRenderer {
    function tokenURI(address game, address player) external view returns (string memory);
}

/// @notice Optional, non-transferable, holder-burnable record of a registered match.
contract QueenCheckRecord is ERC721, IERC5192 {
    error InvalidGame();
    error NotPlayer();
    error AlreadyClaimed();
    error Soulbound();

    address public immutable factory;
    address public immutable renderer;
    mapping(address game => mapping(address player => bool hasClaimed)) public claimed;
    mapping(uint256 tokenId => address game) public gameOf;

    constructor(address factoryAddress, address rendererAddress)
        ERC721("QueenCheck Match Record", "QCR")
    {
        if (factoryAddress == address(0) || rendererAddress.code.length == 0) {
            revert InvalidGame();
        }
        factory = factoryAddress;
        renderer = rendererAddress;
    }

    function claim(address game) external returns (uint256 tokenId) {
        if (!IQueenCheckFactoryRegistry(factory).isGame(game)) revert InvalidGame();
        IQueenCheckGame registeredGame = IQueenCheckGame(game);
        if (
            registeredGame.blackPlayer() == address(0) ||
            (msg.sender != registeredGame.whitePlayer() &&
                msg.sender != registeredGame.blackPlayer())
        ) revert NotPlayer();
        if (claimed[game][msg.sender]) revert AlreadyClaimed();

        claimed[game][msg.sender] = true;
        tokenId = uint256(keccak256(abi.encode(block.chainid, game, msg.sender)));
        gameOf[tokenId] = game;
        _safeMint(msg.sender, tokenId);
        emit Locked(tokenId);
    }

    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function burn(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPlayer();
        _burn(tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address owner = _requireOwned(tokenId);
        return IQueenCheckRenderer(renderer).tokenURI(gameOf[tokenId], owner);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IERC5192).interfaceId || super.supportsInterface(interfaceId);
    }

    function _update(
        address to,
        uint256 tokenId,
        address authorization
    ) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, authorization);
    }
}
