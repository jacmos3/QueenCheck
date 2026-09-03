// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ChessRulesEngine} from "./chess/ChessRulesEngine.sol";

/// @notice One canonical chess state that accepts direct moves or signed checkpoints.
/// @dev This contract deliberately has no payable entry point, owner, upgrade hook, or value custody.
contract QueenCheckGame {
    enum Status {
        Waiting,
        Active,
        Draw,
        WhiteWon,
        BlackWon,
        Cancelled
    }

    struct MoveAuthorization {
        uint256 gameId;
        bytes32 rulesetId;
        uint32 ply;
        bytes32 prevTranscriptRoot;
        uint8 fromSquare;
        uint8 toSquare;
        uint8 promotion;
    }

    struct Position {
        int8[8][8] board;
        bool whiteTurn;
        uint32 ply;
        uint32 halfmoveClock;
        uint8 castlingFlags;
        int8 enPassantCol;
        uint8 enPassantRow;
        uint8 whiteKingRow;
        uint8 whiteKingCol;
        uint8 blackKingRow;
        uint8 blackKingCol;
        Status status;
        bytes32 stateHash;
        bytes32 transcriptRoot;
    }

    bytes32 public constant RULESET_ID = keccak256("QUEENCHECK_STANDARD_CHESS_V1");
    uint8 public constant MAX_BATCH = 16;
    uint32 public constant MIN_TIMEOUT = 5 minutes;
    uint32 public constant MAX_TIMEOUT = 30 days;
    uint32 public constant TIMEOUT_GRACE = 10 minutes;

    bytes32 private constant MOVE_TYPEHASH = keccak256(
        "MoveAuthorization(uint256 gameId,bytes32 rulesetId,uint32 ply,bytes32 prevTranscriptRoot,uint8 fromSquare,uint8 toSquare,uint8 promotion)"
    );
    bytes32 private constant DRAW_TYPEHASH = keccak256(
        "DrawAgreement(uint256 gameId,bytes32 rulesetId,uint32 ply,bytes32 stateHash,bytes32 transcriptRoot)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("QueenCheck");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant TRANSCRIPT_SEED = keccak256("QUEENCHECK_TRANSCRIPT_V1");

    uint8 private constant FLAG_WHITE_KING_MOVED = 1 << 0;
    // These names follow ChessRulesEngine's historical bit convention.
    uint8 private constant FLAG_WHITE_A_ROOK_MOVED = 1 << 1;
    uint8 private constant FLAG_WHITE_H_ROOK_MOVED = 1 << 2;
    uint8 private constant FLAG_BLACK_KING_MOVED = 1 << 3;
    uint8 private constant FLAG_BLACK_H_ROOK_MOVED = 1 << 4;
    uint8 private constant FLAG_BLACK_A_ROOK_MOVED = 1 << 5;

    error AlreadyInitialized();
    error InvalidAddress();
    error InvalidState();
    error Unauthorized();
    error InvalidMove();
    error InvalidAuthorization();
    error InvalidBatch();
    error InvalidTimeout();
    error TooEarly();
    error TimeoutExpired();

    event Joined(address indexed blackPlayer, uint64 turnDeadline);
    event Cancelled();
    event MovePlayed(
        uint32 indexed ply,
        address indexed player,
        uint8 fromSquare,
        uint8 toSquare,
        uint8 promotion,
        bytes32 prevStateHash,
        bytes32 stateHash,
        bytes32 transcriptRoot,
        bool checkpointed
    );
    event GameEnded(Status status);
    event DrawOffered(address indexed player);
    event DrawOfferCancelled();
    event TimeoutSignalled(address indexed claimant, uint64 finalizeAfter);
    event TimeoutCleared();

    address public factory;
    ChessRulesEngine public rules;
    uint256 public gameId;
    address public whitePlayer;
    address public invitedPlayer;
    address public blackPlayer;
    Status public status;
    bool public whiteTurn;
    uint32 public ply;
    uint32 public halfmoveClock;
    uint8 public castlingFlags;
    int8 public enPassantCol;
    uint8 public enPassantRow;
    uint8 public whiteKingRow;
    uint8 public whiteKingCol;
    uint8 public blackKingRow;
    uint8 public blackKingCol;
    uint32 public moveTimeout;
    uint64 public turnStartedAt;
    uint64 public timeoutFinalizeAfter;
    address public timeoutClaimant;
    address public drawOfferer;
    bytes32 public stateHash;
    bytes32 public transcriptRoot;

    int8[8][8] private board;
    mapping(bytes32 positionHash => uint8 occurrences) public repetitions;

    /// @dev Locks the implementation. Minimal-proxy storage starts at zero and can initialize once.
    constructor() {
        factory = address(1);
    }

    function initialize(
        uint256 id,
        address creator,
        address opponent,
        address engine,
        uint32 timeoutSeconds
    ) external {
        if (factory != address(0)) revert AlreadyInitialized();
        if (creator == address(0) || engine.code.length == 0 || opponent == creator) {
            revert InvalidAddress();
        }
        if (
            timeoutSeconds != 0 &&
            (timeoutSeconds < MIN_TIMEOUT || timeoutSeconds > MAX_TIMEOUT)
        ) revert InvalidTimeout();

        factory = msg.sender;
        gameId = id;
        whitePlayer = creator;
        invitedPlayer = opponent;
        rules = ChessRulesEngine(engine);
        moveTimeout = timeoutSeconds;
        whiteTurn = true;
        enPassantCol = -1;
        status = Status.Waiting;
        _setupBoard();

        stateHash = _stateHash(_loadPosition());
        transcriptRoot = _initialTranscriptRoot(stateHash);
        repetitions[_positionHash(_loadPosition())] = 1;
    }

    /// @notice Accept an open challenge, or accept an invitation addressed to the caller.
    function join() external {
        if (status != Status.Waiting || msg.sender == whitePlayer) revert InvalidState();
        if (invitedPlayer != address(0) && msg.sender != invitedPlayer) revert Unauthorized();

        blackPlayer = msg.sender;
        status = Status.Active;
        turnStartedAt = uint64(block.timestamp);
        stateHash = _stateHash(_loadPosition());
        transcriptRoot = _initialTranscriptRoot(stateHash);
        emit Joined(msg.sender, turnDeadline());
    }

    function cancel() external {
        if (status != Status.Waiting || msg.sender != whitePlayer) revert Unauthorized();
        status = Status.Cancelled;
        stateHash = _stateHash(_loadPosition());
        transcriptRoot = _initialTranscriptRoot(stateHash);
        emit Cancelled();
    }

    /// @notice Play one move directly onchain as the player whose turn it is.
    function play(uint8 fromSquare, uint8 toSquare, uint8 promotion) external {
        Position memory current = _loadPosition();
        if (current.status != Status.Active) revert InvalidState();
        _requireMoveWindowOpen();
        if (msg.sender != _expectedPlayer(current)) revert Unauthorized();

        Position memory next = _transition(
            _copyPosition(current),
            fromSquare,
            toSquare,
            promotion
        );
        MoveAuthorization memory authorization = MoveAuthorization({
            gameId: gameId,
            rulesetId: RULESET_ID,
            ply: current.ply,
            prevTranscriptRoot: current.transcriptRoot,
            fromSquare: fromSquare,
            toSquare: toSquare,
            promotion: promotion
        });
        next.transcriptRoot = _nextTranscriptRoot(current.transcriptRoot, authorization);
        _commitMove(current, next, authorization, msg.sender, false);
    }

    /// @notice Archive an ordered batch of moves authorized by alternating players.
    /// @dev Any address may relay. A failure anywhere reverts the whole checkpoint.
    function checkpoint(
        MoveAuthorization[] calldata moves,
        bytes[] calldata signatures
    ) external {
        uint256 length = moves.length;
        if (length == 0 || length > MAX_BATCH || length != signatures.length) {
            revert InvalidBatch();
        }
        _requireMoveWindowOpen();

        for (uint256 index; index < length; ++index) {
            Position memory current = _loadPosition();
            if (current.status != Status.Active) revert InvalidBatch();
            MoveAuthorization calldata authorization = moves[index];
            _checkAuthorization(current, authorization);

            address signer = _expectedPlayer(current);
            if (
                !SignatureChecker.isValidSignatureNow(
                    signer,
                    _typedDataHash(_moveStructHash(authorization)),
                    signatures[index]
                )
            ) revert InvalidAuthorization();

            Position memory next = _transition(
                _copyPosition(current),
                authorization.fromSquare,
                authorization.toSquare,
                authorization.promotion
            );
            next.transcriptRoot = _nextTranscriptRoot(current.transcriptRoot, authorization);
            _commitMove(current, next, authorization, signer, true);
        }
    }

    /// @notice Simulate raw moves from the current canonical state for offline signing.
    /// @dev Returns exactly the state hash and transcript root that each accepted move must commit.
    function previewMoves(
        uint8[] calldata fromSquares,
        uint8[] calldata toSquares,
        uint8[] calldata promotions
    ) external view returns (bytes32[] memory stateHashes, bytes32[] memory transcriptRoots) {
        uint256 length = fromSquares.length;
        if (
            length == 0 ||
            length > MAX_BATCH ||
            toSquares.length != length ||
            promotions.length != length
        ) revert InvalidBatch();
        _requireMoveWindowOpen();

        Position memory position = _loadPosition();
        bytes32[] memory localPositions = new bytes32[](length);
        stateHashes = new bytes32[](length);
        transcriptRoots = new bytes32[](length);

        for (uint256 index; index < length; ++index) {
            if (position.status != Status.Active) revert InvalidBatch();
            Position memory previous = _copyPosition(position);
            position = _transitionPreview(
                position,
                fromSquares[index],
                toSquares[index],
                promotions[index],
                localPositions,
                index
            );
            MoveAuthorization memory authorization = MoveAuthorization({
                gameId: gameId,
                rulesetId: RULESET_ID,
                ply: previous.ply,
                prevTranscriptRoot: previous.transcriptRoot,
                fromSquare: fromSquares[index],
                toSquare: toSquares[index],
                promotion: promotions[index]
            });
            position.transcriptRoot = _nextTranscriptRoot(previous.transcriptRoot, authorization);
            stateHashes[index] = position.stateHash;
            transcriptRoots[index] = position.transcriptRoot;
        }
    }

    function offerDraw() external {
        _requirePlayer();
        if (status != Status.Active) revert InvalidState();
        _requireMoveWindowOpen();
        drawOfferer = msg.sender;
        emit DrawOffered(msg.sender);
    }

    function cancelDrawOffer() external {
        _requireMoveWindowOpen();
        if (msg.sender != drawOfferer) revert Unauthorized();
        drawOfferer = address(0);
        emit DrawOfferCancelled();
    }

    function acceptDraw() external {
        _requirePlayer();
        if (
            status != Status.Active ||
            drawOfferer == address(0) ||
            drawOfferer == msg.sender
        ) revert InvalidState();
        _requireMoveWindowOpen();
        _endGame(Status.Draw);
    }

    function agreeDraw(bytes calldata whiteSignature, bytes calldata blackSignature) external {
        if (status != Status.Active) revert InvalidState();
        _requireMoveWindowOpen();
        bytes32 agreement = keccak256(
            abi.encode(
                DRAW_TYPEHASH,
                gameId,
                RULESET_ID,
                ply,
                stateHash,
                transcriptRoot
            )
        );
        bytes32 digest = _typedDataHash(agreement);
        if (
            !SignatureChecker.isValidSignatureNow(whitePlayer, digest, whiteSignature) ||
            !SignatureChecker.isValidSignatureNow(blackPlayer, digest, blackSignature)
        ) revert InvalidAuthorization();
        _endGame(Status.Draw);
    }

    function resign() external {
        _requirePlayer();
        if (status != Status.Active) revert InvalidState();
        _requireMoveWindowOpen();
        _endGame(msg.sender == whitePlayer ? Status.BlackWon : Status.WhiteWon);
    }

    function claimThreefold() external {
        _requirePlayer();
        Position memory position = _loadPosition();
        if (msg.sender != _expectedPlayer(position)) revert Unauthorized();
        _requireMoveWindowOpen();
        if (
            position.status != Status.Active ||
            repetitions[_positionHash(position)] < 3
        ) revert InvalidState();
        _endGame(Status.Draw);
    }

    function claimFiftyMove() external {
        _requirePlayer();
        Position memory position = _loadPosition();
        if (msg.sender != _expectedPlayer(position)) revert Unauthorized();
        _requireMoveWindowOpen();
        if (position.status != Status.Active || position.halfmoveClock < 100) {
            revert InvalidState();
        }
        _endGame(Status.Draw);
    }

    /// @notice Start the grace period after the current player's turn deadline has elapsed.
    function signalTimeout() external {
        _requirePlayer();
        Position memory position = _loadPosition();
        if (
            position.status != Status.Active ||
            moveTimeout == 0 ||
            msg.sender == _expectedPlayer(position) ||
            timeoutFinalizeAfter != 0
        ) revert InvalidState();
        if (block.timestamp < turnDeadline()) revert TooEarly();

        timeoutClaimant = msg.sender;
        timeoutFinalizeAfter = uint64(block.timestamp + TIMEOUT_GRACE);
        emit TimeoutSignalled(msg.sender, timeoutFinalizeAfter);
    }

    function finalizeTimeout() external {
        if (
            status != Status.Active ||
            timeoutFinalizeAfter == 0 ||
            block.timestamp < timeoutFinalizeAfter
        ) revert TooEarly();
        _endGame(timeoutClaimant == whitePlayer ? Status.WhiteWon : Status.BlackWon);
    }

    function turnDeadline() public view returns (uint64) {
        if (status != Status.Active || moveTimeout == 0) return 0;
        return turnStartedAt + moveTimeout;
    }

    function playerToMove() external view returns (address) {
        return _expectedPlayer(_loadPosition());
    }

    function rulesetId() external pure returns (bytes32) {
        return RULESET_ID;
    }

    function getBoard() external view returns (int8[64] memory flattened) {
        for (uint8 row; row < 8; ++row) {
            for (uint8 col; col < 8; ++col) {
                flattened[uint256(row) * 8 + col] = board[row][col];
            }
        }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    function moveDigest(MoveAuthorization calldata authorization) external view returns (bytes32) {
        return _typedDataHash(_moveStructHash(authorization));
    }

    function _transition(
        Position memory position,
        uint8 fromSquare,
        uint8 toSquare,
        uint8 promotion
    ) internal view returns (Position memory) {
        bytes32 positionHash = _applyChessMove(position, fromSquare, toSquare, promotion);
        uint8 occurrences = repetitions[positionHash] + 1;
        _resolvePosition(position, occurrences);
        position.stateHash = _stateHash(position);
        return position;
    }

    function _transitionPreview(
        Position memory position,
        uint8 fromSquare,
        uint8 toSquare,
        uint8 promotion,
        bytes32[] memory localPositions,
        uint256 localLength
    ) internal view returns (Position memory) {
        bytes32 positionHash = _applyChessMove(position, fromSquare, toSquare, promotion);
        uint256 occurrences = uint256(repetitions[positionHash]) + 1;
        for (uint256 index; index < localLength; ++index) {
            if (localPositions[index] == positionHash) ++occurrences;
        }
        localPositions[localLength] = positionHash;
        _resolvePosition(position, uint8(occurrences));
        position.stateHash = _stateHash(position);
        return position;
    }

    function _applyChessMove(
        Position memory position,
        uint8 fromSquare,
        uint8 toSquare,
        uint8 promotion
    ) internal view returns (bytes32) {
        if (fromSquare > 63 || toSquare > 63 || fromSquare == toSquare) revert InvalidMove();
        uint8 fromRow = fromSquare / 8;
        uint8 fromCol = fromSquare % 8;
        uint8 toRow = toSquare / 8;
        uint8 toCol = toSquare % 8;
        int8 piece = position.board[fromRow][fromCol];

        if (
            piece == 0 ||
            (piece > 0) != position.whiteTurn ||
            !rules.isValidMoveView(
                position.board,
                position.enPassantCol,
                position.enPassantRow,
                position.castlingFlags,
                fromRow,
                fromCol,
                toRow,
                toCol
            ) ||
            rules.wouldMoveLeaveKingInCheck(
                position.board,
                position.whiteKingRow,
                position.whiteKingCol,
                position.blackKingRow,
                position.blackKingCol,
                fromRow,
                fromCol,
                toRow,
                toCol
            )
        ) revert InvalidMove();

        int8 captured = position.board[toRow][toCol];
        bool pawn = piece == 1 || piece == -1;
        if (pawn && fromCol != toCol && captured == 0) {
            captured = position.board[fromRow][toCol];
            position.board[fromRow][toCol] = 0;
        }

        position.board[fromRow][fromCol] = 0;
        position.board[toRow][toCol] = piece;
        _applySpecialMove(position, piece, fromRow, fromCol, toRow, toCol, captured);

        position.enPassantCol = -1;
        position.enPassantRow = 0;
        if (pawn && _delta(fromRow, toRow) == 2) {
            position.enPassantCol = int8(toCol);
            position.enPassantRow = toRow;
        }

        if (pawn && (toRow == 0 || toRow == 7)) {
            if (promotion < 2 || promotion > 5) revert InvalidMove();
            position.board[toRow][toCol] = piece > 0
                ? int8(promotion)
                : -int8(promotion);
        } else if (promotion != 0) {
            revert InvalidMove();
        }

        position.halfmoveClock = (pawn || captured != 0)
            ? 0
            : position.halfmoveClock + 1;
        bool moverWasWhite = position.whiteTurn;
        position.whiteTurn = !position.whiteTurn;
        ++position.ply;

        bytes32 positionHash = _positionHash(position);
        (,, uint8 detectedState) = rules.detectCheckState(
            position.board,
            moverWasWhite,
            false,
            false,
            position.whiteKingRow,
            position.whiteKingCol,
            position.blackKingRow,
            position.blackKingCol,
            position.enPassantCol,
            position.enPassantRow,
            position.castlingFlags,
            0,
            0
        );
        position.status = Status(detectedState);
        return positionHash;
    }

    function _resolvePosition(Position memory position, uint8 occurrences) internal pure {
        if (position.status != Status.Active) return;
        if (
            position.halfmoveClock >= 150 ||
            occurrences >= 5 ||
            _hasInsufficientMaterial(position.board)
        ) position.status = Status.Draw;
    }

    function _commitMove(
        Position memory previous,
        Position memory next,
        MoveAuthorization memory authorization,
        address player,
        bool checkpointed
    ) internal {
        bytes32 nextPositionHash = _positionHash(next);
        ++repetitions[nextPositionHash];
        _storePosition(next);

        drawOfferer = address(0);
        if (timeoutFinalizeAfter != 0) emit TimeoutCleared();
        timeoutFinalizeAfter = 0;
        timeoutClaimant = address(0);
        turnStartedAt = next.status == Status.Active ? uint64(block.timestamp) : 0;

        emit MovePlayed(
            authorization.ply,
            player,
            authorization.fromSquare,
            authorization.toSquare,
            authorization.promotion,
            previous.stateHash,
            next.stateHash,
            next.transcriptRoot,
            checkpointed
        );
        if (next.status != Status.Active) emit GameEnded(next.status);
    }

    function _applySpecialMove(
        Position memory position,
        int8 piece,
        uint8 fromRow,
        uint8 fromCol,
        uint8 toRow,
        uint8 toCol,
        int8 captured
    ) internal pure {
        if (piece == 6) {
            position.whiteKingRow = toRow;
            position.whiteKingCol = toCol;
            position.castlingFlags |= FLAG_WHITE_KING_MOVED;
            if (fromCol == 4 && toCol == 6) {
                position.board[7][5] = 4;
                position.board[7][7] = 0;
            } else if (fromCol == 4 && toCol == 2) {
                position.board[7][3] = 4;
                position.board[7][0] = 0;
            }
        } else if (piece == -6) {
            position.blackKingRow = toRow;
            position.blackKingCol = toCol;
            position.castlingFlags |= FLAG_BLACK_KING_MOVED;
            if (fromCol == 4 && toCol == 6) {
                position.board[0][5] = -4;
                position.board[0][7] = 0;
            } else if (fromCol == 4 && toCol == 2) {
                position.board[0][3] = -4;
                position.board[0][0] = 0;
            }
        }

        if (piece == 4 && fromRow == 7) {
            if (fromCol == 7) position.castlingFlags |= FLAG_WHITE_H_ROOK_MOVED;
            if (fromCol == 0) position.castlingFlags |= FLAG_WHITE_A_ROOK_MOVED;
        } else if (piece == -4 && fromRow == 0) {
            if (fromCol == 7) position.castlingFlags |= FLAG_BLACK_H_ROOK_MOVED;
            if (fromCol == 0) position.castlingFlags |= FLAG_BLACK_A_ROOK_MOVED;
        }

        if (captured == 4 && toRow == 7) {
            if (toCol == 7) position.castlingFlags |= FLAG_WHITE_H_ROOK_MOVED;
            if (toCol == 0) position.castlingFlags |= FLAG_WHITE_A_ROOK_MOVED;
        } else if (captured == -4 && toRow == 0) {
            if (toCol == 7) position.castlingFlags |= FLAG_BLACK_H_ROOK_MOVED;
            if (toCol == 0) position.castlingFlags |= FLAG_BLACK_A_ROOK_MOVED;
        }
    }

    function _checkAuthorization(
        Position memory current,
        MoveAuthorization calldata authorization
    ) internal view {
        if (
            authorization.gameId != gameId ||
            authorization.rulesetId != RULESET_ID ||
            authorization.ply != current.ply ||
            authorization.prevTranscriptRoot != current.transcriptRoot ||
            authorization.fromSquare > 63 ||
            authorization.toSquare > 63
        ) revert InvalidAuthorization();
    }

    function _moveStructHash(
        MoveAuthorization memory authorization
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MOVE_TYPEHASH,
                authorization.gameId,
                authorization.rulesetId,
                authorization.ply,
                authorization.prevTranscriptRoot,
                authorization.fromSquare,
                authorization.toSquare,
                authorization.promotion
            )
        );
    }

    function _typedDataHash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _requireMoveWindowOpen() internal view {
        if (
            timeoutFinalizeAfter != 0 &&
            block.timestamp >= timeoutFinalizeAfter
        ) revert TimeoutExpired();
    }

    function _nextTranscriptRoot(
        bytes32 previousRoot,
        MoveAuthorization memory authorization
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(previousRoot, _moveStructHash(authorization)));
    }

    function _initialTranscriptRoot(bytes32 initialStateHash) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                TRANSCRIPT_SEED,
                block.chainid,
                address(this),
                gameId,
                RULESET_ID,
                initialStateHash
            )
        );
    }

    function _endGame(Status result) internal {
        status = result;
        stateHash = _stateHash(_loadPosition());
        drawOfferer = address(0);
        timeoutClaimant = address(0);
        timeoutFinalizeAfter = 0;
        turnStartedAt = 0;
        emit GameEnded(result);
    }

    function _expectedPlayer(Position memory position) internal view returns (address) {
        return position.whiteTurn ? whitePlayer : blackPlayer;
    }

    function _requirePlayer() internal view {
        if (msg.sender != whitePlayer && msg.sender != blackPlayer) revert Unauthorized();
    }

    function _loadPosition() internal view returns (Position memory position) {
        position.board = board;
        position.whiteTurn = whiteTurn;
        position.ply = ply;
        position.halfmoveClock = halfmoveClock;
        position.castlingFlags = castlingFlags;
        position.enPassantCol = enPassantCol;
        position.enPassantRow = enPassantRow;
        position.whiteKingRow = whiteKingRow;
        position.whiteKingCol = whiteKingCol;
        position.blackKingRow = blackKingRow;
        position.blackKingCol = blackKingCol;
        position.status = status;
        position.stateHash = stateHash;
        position.transcriptRoot = transcriptRoot;
    }

    function _copyPosition(Position memory source) internal pure returns (Position memory target) {
        for (uint8 row; row < 8; ++row) {
            for (uint8 col; col < 8; ++col) {
                target.board[row][col] = source.board[row][col];
            }
        }
        target.whiteTurn = source.whiteTurn;
        target.ply = source.ply;
        target.halfmoveClock = source.halfmoveClock;
        target.castlingFlags = source.castlingFlags;
        target.enPassantCol = source.enPassantCol;
        target.enPassantRow = source.enPassantRow;
        target.whiteKingRow = source.whiteKingRow;
        target.whiteKingCol = source.whiteKingCol;
        target.blackKingRow = source.blackKingRow;
        target.blackKingCol = source.blackKingCol;
        target.status = source.status;
        target.stateHash = source.stateHash;
        target.transcriptRoot = source.transcriptRoot;
    }

    function _storePosition(Position memory position) internal {
        board = position.board;
        whiteTurn = position.whiteTurn;
        ply = position.ply;
        halfmoveClock = position.halfmoveClock;
        castlingFlags = position.castlingFlags;
        enPassantCol = position.enPassantCol;
        enPassantRow = position.enPassantRow;
        whiteKingRow = position.whiteKingRow;
        whiteKingCol = position.whiteKingCol;
        blackKingRow = position.blackKingRow;
        blackKingCol = position.blackKingCol;
        status = position.status;
        stateHash = position.stateHash;
        transcriptRoot = position.transcriptRoot;
    }

    function _stateHash(Position memory position) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                gameId,
                RULESET_ID,
                whitePlayer,
                blackPlayer,
                position.board,
                position.whiteTurn,
                position.ply,
                position.halfmoveClock,
                position.castlingFlags,
                position.enPassantCol,
                position.enPassantRow,
                position.status
            )
        );
    }

    function _positionHash(Position memory position) internal view returns (bytes32) {
        (int8 canonicalCol, uint8 canonicalRow) = rules.canonicalEnPassantForPosition(
            position.board,
            position.whiteTurn,
            position.whiteKingRow,
            position.whiteKingCol,
            position.blackKingRow,
            position.blackKingCol,
            position.enPassantCol,
            position.enPassantRow
        );
        return keccak256(
            abi.encode(
                position.board,
                position.whiteTurn,
                position.castlingFlags,
                canonicalCol,
                canonicalRow
            )
        );
    }

    function _setupBoard() internal {
        int8[8] memory pieces = [int8(4), 2, 3, 5, 6, 3, 2, 4];
        for (uint8 col; col < 8; ++col) {
            board[0][col] = -pieces[col];
            board[1][col] = -1;
            board[6][col] = 1;
            board[7][col] = pieces[col];
        }
        whiteKingRow = 7;
        whiteKingCol = 4;
        blackKingRow = 0;
        blackKingCol = 4;
    }

    function _hasInsufficientMaterial(int8[8][8] memory positionBoard) internal pure returns (bool) {
        uint8 minors;
        uint8 bishops;
        uint8 bishopSquareColor = 2;
        for (uint8 row; row < 8; ++row) {
            for (uint8 col; col < 8; ++col) {
                int8 piece = positionBoard[row][col];
                uint8 absolutePiece = piece < 0 ? uint8(-piece) : uint8(piece);
                if (absolutePiece == 1 || absolutePiece == 4 || absolutePiece == 5) {
                    return false;
                }
                if (absolutePiece == 2) ++minors;
                if (absolutePiece == 3) {
                    ++minors;
                    ++bishops;
                    uint8 squareColor = (row + col) % 2;
                    if (bishopSquareColor == 2) bishopSquareColor = squareColor;
                    else if (bishopSquareColor != squareColor) return false;
                }
            }
        }
        return minors <= 1 || minors == bishops;
    }

    function _delta(uint8 first, uint8 second) internal pure returns (uint8) {
        return first > second ? first - second : second - first;
    }
}
