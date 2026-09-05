<script>
  import { env } from '$env/dynamic/public';
  import { Chess } from 'chess.js';
  import { ContractFunctionRevertedError, getAddress, zeroAddress } from 'viem';
  import { onMount } from 'svelte';
  import ChessBoard from './ChessBoard.svelte';
  import WalletButton from './WalletButton.svelte';
  import { algebraicToIndex, boardToFen, chessToSignedBoard, EMPTY_BOARD, indexToAlgebraic, kingSquare, shortAddress } from '$lib/board.js';
  import { assertTrustedDeployment } from '$lib/deployment.js';
  import { factoryAbi, gameAbi, recordAbi } from '$lib/contracts/abi.js';
  import { moveTypedData, nextTranscriptRoot } from '$lib/eip712.js';
  import { discardQueuedTranscript, loadTranscript, mergeTranscripts, parseTranscriptJson, pruneTranscriptBeforePly, saveQueuedTranscriptMove, saveTranscript, TRANSCRIPT_SCHEMA, validateTranscriptContinuation } from '$lib/transcript.js';
  import { matchRecordAvailability, matchRecordTokenId } from '$lib/game-actions.js';
  import { createDrawAgreement, drawAgreementTypedData, parseDrawAgreementJson, validateDrawAgreement, withDrawSignature } from '$lib/draw-agreement.js';
  import { getPublicReadSession } from '$lib/public-client.js';
  import { assertSessionCurrent, waitForSuccessfulReceipt } from '$lib/wallet.js';

  export let address;
  const publicReadSession = getPublicReadSession();
  let session = null;
  let verified = false;
  let loading = true;
  let busy = false;
  let error = '';
  let notice = '';
  let selected = null;
  let mode = 'live';
  let promotion = 5;
  let importText = '';
  let drawImportText = '';
  let drawAgreement = null;
  let recordAddress = '';
  let recordClaimed = false;
  let recordOwner = '';
  let recordTokenId = null;
  let canClaimThreefold = false;
  let sessionGeneration = 0;
  let refreshGeneration = 0;
  let board = [...EMPTY_BOARD];
  let displayBoard = [...EMPTY_BOARD];
  let displayChess = null;
  let lastLiveMove = null;
  let now = Date.now();
  let game = {
    white: '', black: '', invited: '', status: 0, whiteTurn: true, ply: 0, gameId: '0', rulesetId: '',
    stateHash: '', transcriptRoot: '', castlingFlags: 0, enPassantCol: -1,
    enPassantRow: 0, halfmoveClock: 0, moveTimeout: 0, turnDeadline: 0, timeoutFinalizeAfter: 0, drawOfferer: ''
  };
  let transcript = { schema: TRANSCRIPT_SCHEMA, chainId: 0, game: address, moves: [] };
  const statusLabels = ['Open', 'Active', 'Draw', 'White won', 'Black won', 'Cancelled'];

  $: queued = transcript.moves.filter((move) => Number(move.ply) >= Number(game.ply));
  $: expectedPlayer = queued.length % 2 === 0
    ? (game.whiteTurn ? game.white : game.black)
    : (game.whiteTurn ? game.black : game.white);
  $: onchainPlayer = game.whiteTurn ? game.white : game.black;
  $: canSign = session && game.status === 1 && expectedPlayer && session.account.toLowerCase() === expectedPlayer.toLowerCase();
  $: isPlayer = session && [game.white, game.black].some((player) => player && player.toLowerCase() === session.account.toLowerCase());
  $: canCancelDraw = isPlayer && game.status === 1 && game.drawOfferer && game.drawOfferer.toLowerCase() === session.account.toLowerCase();
  $: canClaimFifty = isPlayer && game.status === 1 && game.halfmoveClock >= 100 && onchainPlayer && session.account.toLowerCase() === onchainPlayer.toLowerCase();
  $: recordActions = matchRecordAvailability(game, session?.account, recordClaimed, recordOwner);
  $: flipped = Boolean(session && game.black && session.account.toLowerCase() === game.black.toLowerCase());
  $: sideToMoveWhite = queued.length % 2 === 0 ? game.whiteTurn : !game.whiteTurn;
  $: lastMove = queued.length
    ? { from: Number(queued.at(-1).fromSquare), to: Number(queued.at(-1).toSquare) }
    : lastLiveMove;
  $: legalSquares = selected == null || !displayChess
    ? []
    : displayChess.moves({ square: indexToAlgebraic(selected), verbose: true }).map((move) => algebraicToIndex(move.to));
  $: checkSquare = displayChess?.inCheck() ? kingSquare(displayBoard, displayChess.turn() === 'w') : null;
  $: canJoin = Boolean(
    session && game.status === 0 && game.white &&
    session.account.toLowerCase() !== game.white.toLowerCase() &&
    (!game.invited || game.invited === zeroAddress || session.account.toLowerCase() === game.invited.toLowerCase())
  );
  $: canSignalTimeout = Boolean(
    isPlayer && game.status === 1 && game.moveTimeout && onchainPlayer &&
    session.account.toLowerCase() !== onchainPlayer.toLowerCase() && !Number(game.timeoutFinalizeAfter)
  );
  $: canFinalizeTimeout = Boolean(Number(game.timeoutFinalizeAfter) && now / 1000 >= Number(game.timeoutFinalizeAfter));
  $: clockLabel = formatClock(game.turnDeadline, now);
  $: turnLabel = game.status !== 1
    ? (statusLabels[game.status] ?? `State ${game.status}`)
    : `${sideToMoveWhite ? 'White' : 'Black'} to move${queued.length ? ' · local queue' : ''}`;

  onMount(() => {
    const tick = setInterval(() => { now = Date.now(); }, 1000);
    void refresh(null, sessionGeneration);
    return () => {
      clearInterval(tick);
      refreshGeneration += 1;
      sessionGeneration += 1;
    };
  });

  function formatClock(deadline, timestamp) {
    const seconds = Number(deadline);
    if (!seconds) return '';
    const remaining = Math.max(0, seconds * 1000 - timestamp);
    const total = Math.floor(remaining / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function friendly(cause) {
    if (!cause || typeof cause !== 'object') return 'Operation failed';
    return typeof cause.shortMessage === 'string' ? cause.shortMessage : cause instanceof Error ? cause.message : 'Operation failed';
  }
  function resetMessage() { error = ''; notice = ''; }

  async function connected(value) {
    sessionGeneration += 1;
    session = value;
    const generation = sessionGeneration;
    let storageWarning = '';
    try { transcript = loadTranscript(localStorage, session.chainId, address, session.account); }
    catch (cause) {
      transcript = { schema: TRANSCRIPT_SCHEMA, chainId: session.chainId, game: address, moves: [] };
      storageWarning = `Stored transcript was ignored: ${friendly(cause)}`;
    }
    await refresh(value, generation);
    if (storageWarning && session === value && sessionGeneration === generation) notice = storageWarning;
  }

  function disconnected() {
    sessionGeneration += 1;
    session = null;
    busy = false;
    canClaimThreefold = false;
    drawAgreement = null;
    recordClaimed = false;
    recordOwner = '';
    recordTokenId = null;
    transcript = { schema: TRANSCRIPT_SCHEMA, chainId: publicReadSession.chainId, game: address, moves: [] };
    displayChess = null;
    selected = null;
    void refresh(null, sessionGeneration);
  }

  async function readMatchRecordState(publicClient, chainId, record, account) {
    const tokenId = matchRecordTokenId(chainId, address, account);
    const claimed = await publicClient.readContract({
      address: record, abi: recordAbi, functionName: 'claimed', args: [address, account]
    });
    let owner = '';
    if (claimed) {
      try {
        owner = await publicClient.readContract({ address: record, abi: recordAbi, functionName: 'ownerOf', args: [tokenId] });
      } catch (cause) {
        const reverted = cause instanceof ContractFunctionRevertedError
          ? cause
          : typeof cause?.walk === 'function'
            ? cause.walk((item) => item instanceof ContractFunctionRevertedError)
            : null;
        if (reverted?.data?.errorName !== 'ERC721NonexistentToken') throw cause;
      }
    }
    return { claimed: Boolean(claimed), owner, tokenId };
  }

  async function refreshMatchRecordState(snapshot, generation) {
    const next = await readMatchRecordState(snapshot.publicClient, snapshot.chainId, recordAddress, snapshot.account);
    assertSessionCurrent(session, snapshot, sessionGeneration, generation);
    recordClaimed = next.claimed;
    recordOwner = next.owner;
    recordTokenId = next.tokenId;
  }

  async function refresh(snapshot = session, generation = sessionGeneration) {
    const reader = snapshot ?? publicReadSession;
    const request = ++refreshGeneration;
    const isCurrent = () => request === refreshGeneration && (
      !snapshot || (session === snapshot && sessionGeneration === generation)
    );
    resetMessage(); loading = true; verified = false;
    try {
      if (snapshot) assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const rpcChainId = Number(await reader.publicClient.getChainId());
      if (rpcChainId !== Number(reader.chainId)) throw new Error('The read provider returned an unexpected network.');
      if (!isCurrent()) return false;
      const trustedDeployment = await assertTrustedDeployment(reader.publicClient, reader.chainId, env);
      if (!isCurrent()) return false;
      if (snapshot) assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const factoryAddress = trustedDeployment.factory;
      const [code, registered] = await Promise.all([
        reader.publicClient.getCode({ address }),
        reader.publicClient.readContract({ address: factoryAddress, abi: factoryAbi, functionName: 'isGame', args: [address] })
      ]);
      if (!code || code === '0x') throw new Error('No contract bytecode exists at this address.');
      if (!registered) throw new Error('This contract is not registered by the configured QueenCheck factory.');
      const normalizedRecord = trustedDeployment.record;
      const [white, black, invited, status, whiteTurn, ply, gameId, rulesetId, stateHash, transcriptRoot, castlingFlags, enPassantCol, enPassantRow, halfmoveClock, moveTimeout, turnDeadline, timeoutFinalizeAfter, drawOfferer, rawBoard] = await Promise.all([
        ...['whitePlayer', 'blackPlayer', 'invitedPlayer', 'status', 'whiteTurn', 'ply', 'gameId', 'rulesetId', 'stateHash', 'transcriptRoot', 'castlingFlags', 'enPassantCol', 'enPassantRow', 'halfmoveClock', 'moveTimeout', 'turnDeadline', 'timeoutFinalizeAfter', 'drawOfferer', 'getBoard'].map((functionName) => reader.publicClient.readContract({ address, abi: gameAbi, functionName }))
      ]);
      const nextGame = {
        white, black, invited, status: Number(status), whiteTurn, ply: Number(ply), gameId: String(gameId),
        rulesetId, stateHash, transcriptRoot, castlingFlags: Number(castlingFlags),
        enPassantCol: Number(enPassantCol), enPassantRow: Number(enPassantRow),
        halfmoveClock: Number(halfmoveClock), moveTimeout: Number(moveTimeout),
        turnDeadline: Number(turnDeadline), timeoutFinalizeAfter: Number(timeoutFinalizeAfter), drawOfferer
      };
      const nextRecordState = snapshot
        ? await readMatchRecordState(reader.publicClient, reader.chainId, normalizedRecord, snapshot.account)
        : { claimed: false, owner: '', tokenId: null };
      let threefold = false;
      const player = snapshot && [white, black].some((candidate) => candidate && candidate.toLowerCase() === snapshot.account.toLowerCase());
      if (Number(status) === 1 && player) {
        try {
          await reader.publicClient.simulateContract({ address, abi: gameAbi, functionName: 'claimThreefold', account: snapshot.account });
          threefold = true;
        } catch { /* disabled unless the exact call currently succeeds */ }
      }
      if (!isCurrent()) return false;
      if (snapshot) assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      game = nextGame;
      board = [...rawBoard].map(Number);
      recordAddress = normalizedRecord;
      recordClaimed = nextRecordState.claimed;
      recordOwner = nextRecordState.owner;
      recordTokenId = nextRecordState.tokenId;
      canClaimThreefold = threefold;
      if (snapshot && drawAgreement) {
        try { drawAgreement = validateDrawAgreement(drawAgreement, { chainId: snapshot.chainId, game: address, state: nextGame }); }
        catch { drawAgreement = null; }
      } else if (!snapshot) drawAgreement = null;
      rebuildDisplayBoard();
      verified = true;
      return true;
    } catch (cause) {
      if (isCurrent()) error = friendly(cause);
      return false;
    } finally {
      if (isCurrent()) loading = false;
    }
  }

  function rebuildDisplayBoard() {
    try {
      const chess = new Chess(boardToFen(board, {
        whiteToMove: game.whiteTurn,
        castlingFlags: game.castlingFlags,
        enPassantCol: game.enPassantCol,
        enPassantRow: game.enPassantRow,
        halfmoveClock: game.halfmoveClock,
        ply: game.ply
      }));
      for (const item of queued) {
        const move = { from: indexToAlgebraic(Number(item.fromSquare)), to: indexToAlgebraic(Number(item.toSquare)) };
        if (Number(item.promotion)) move.promotion = promotionLetter(Number(item.promotion));
        chess.move(move);
      }
      displayChess = chess;
      displayBoard = chessToSignedBoard(chess);
    } catch {
      displayChess = null;
      displayBoard = [...board];
    }
  }

  const promotionLetter = (value) => ({ 2: 'n', 3: 'b', 4: 'r', 5: 'q' }[value] ?? 'q');
  async function selectSquare(index) {
    resetMessage();
    if (!verified || busy || game.status !== 1) return;
    if (selected === null) { if (displayBoard[index]) selected = index; return; }
    if (index === selected) { selected = null; return; }
    if (displayBoard[index] && Number(displayBoard[index]) * Number(displayBoard[selected]) > 0) {
      selected = index;
      return;
    }
    if (!legalSquares.includes(index)) { selected = null; return; }
    const from = selected; selected = null;
    const snapshot = session;
    const generation = sessionGeneration;
    try {
      if (!displayChess) throw new Error('The local position could not be reconstructed. Refresh before signing or sending a move.');
      const piece = Number(displayBoard[from]);
      const isPromotion = Math.abs(piece) === 1 && (Math.floor(index / 8) === 0 || Math.floor(index / 8) === 7);
      const promotionValue = isPromotion ? Number(promotion) : 0;
      const preview = new Chess(displayChess.fen());
      const candidate = { from: indexToAlgebraic(from), to: indexToAlgebraic(index) };
      if (promotionValue) candidate.promotion = promotionLetter(promotionValue);
      if (!preview.move(candidate)) throw new Error('That move is not legal in the current position.');

      if (mode === 'live') {
        if (queued.length) throw new Error('Archive the queued offline moves before returning to live play.');
        const currentPlayer = game.whiteTurn ? game.white : game.black;
        if (!session || session.account.toLowerCase() !== currentPlayer.toLowerCase()) throw new Error(`The current move belongs to ${currentPlayer}.`);
        const played = await sendWrite('play', [from, index, promotionValue], 'Move confirmed. The onchain SVG is now updated.');
        if (played) lastLiveMove = { from, to: index };
      } else {
        await signOfflineMove(from, index, promotionValue);
      }
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) error = friendly(cause);
    }
  }

  async function signOfflineMove(from, to, promotionValue) {
    if (!canSign) throw new Error(`The next signature must come from ${expectedPlayer || 'the current player'}. Export the transcript for the other player if this browser uses a different wallet.`);
    const snapshot = session;
    const generation = sessionGeneration;
    busy = true;
    try {
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      validateTranscriptContinuation(queued, game);
      await verifyQueuedSignatures(queued, snapshot, generation);
      const message = {
        gameId: BigInt(game.gameId),
        rulesetId: game.rulesetId,
        ply: Number(game.ply) + queued.length,
        prevTranscriptRoot: queued.at(-1)?.nextTranscriptRoot ?? game.transcriptRoot,
        fromSquare: from,
        toSquare: to,
        promotion: promotionValue
      };
      const computedNextRoot = nextTranscriptRoot(message);
      const signature = await snapshot.walletClient.signTypedData({ account: snapshot.account, ...moveTypedData(snapshot.chainId, address, message) });
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      transcript = saveQueuedTranscriptMove(localStorage, transcript, game.ply, {
        ...message,
        gameId: String(message.gameId),
        nextTranscriptRoot: computedNextRoot,
        signer: snapshot.account,
        signature
      }, snapshot.account);
      rebuildDisplayBoard();
      notice = 'Move signed locally. Export it for the other player, or archive when the batch has every required signature.';
    } finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  async function sendWrite(functionName, args = [], success = 'Transaction confirmed.') {
    if (!session) { error = 'Connect a wallet first.'; return false; }
    const snapshot = session;
    const generation = sessionGeneration;
    resetMessage(); busy = true;
    try {
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const hash = await snapshot.walletClient.writeContract({ address, abi: gameAbi, functionName, args });
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      await waitForSuccessfulReceipt(snapshot.publicClient, hash);
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const refreshed = await refresh(snapshot, generation);
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      notice = refreshed
        ? success
        : 'Transaction confirmed, but the latest state could not be refreshed. Retry after checking the RPC connection.';
      return true;
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) error = friendly(cause);
      return false;
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  async function checkpoint() {
    if (!queued.length) { error = 'There are no signed moves to archive.'; return; }
    const batch = queued.slice(0, 16);
    const snapshot = session;
    const generation = sessionGeneration;
    busy = true;
    try {
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      validateTranscriptContinuation(queued, game);
      await verifyQueuedSignatures(batch, snapshot, generation);
      const [, roots] = await snapshot.publicClient.readContract({
        address,
        abi: gameAbi,
        functionName: 'previewMoves',
        args: [
          batch.map((move) => Number(move.fromSquare)),
          batch.map((move) => Number(move.toSquare)),
          batch.map((move) => Number(move.promotion))
        ]
      });
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      if (roots.length !== batch.length || roots.some((root, index) => root !== batch[index].nextTranscriptRoot)) throw new Error('The signed transcript does not match the contract preview.');
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) error = friendly(cause);
      if (session === snapshot && sessionGeneration === generation) busy = false;
      return;
    }
    const checkpointAccount = session?.account;
    const succeeded = await sendWrite(
      'checkpoint',
      [
        batch.map((move) => ({
          gameId: BigInt(move.gameId),
          rulesetId: move.rulesetId,
          ply: Number(move.ply),
          prevTranscriptRoot: move.prevTranscriptRoot,
          fromSquare: Number(move.fromSquare),
          toSquare: Number(move.toSquare),
          promotion: Number(move.promotion)
        })),
        batch.map((move) => move.signature)
      ],
      `${batch.length} signed move(s) archived. The onchain SVG has been updated.`
    );
    if (succeeded && session && checkpointAccount && session.account === checkpointAccount) {
      try {
        const nextTranscript = pruneTranscriptBeforePly(transcript, game.ply);
        transcript = saveTranscript(localStorage, nextTranscript, session.account);
        rebuildDisplayBoard();
      } catch (cause) {
        error = `The checkpoint succeeded, but the local transcript could not be updated: ${friendly(cause)}`;
      }
    }
  }

  function exportTranscript() {
    const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `queencheck-${address}-${game.ply}.json`; link.click(); URL.revokeObjectURL(url);
  }

  function discardTranscript() {
    resetMessage();
    if (!session) { error = 'Connect a wallet first.'; return; }
    if (!window.confirm(`Discard ${queued.length} queued offline move(s) for this account? This cannot be undone.`)) return;
    try {
      transcript = saveTranscript(localStorage, discardQueuedTranscript(transcript, game.ply), session.account);
      rebuildDisplayBoard();
      notice = 'Queued offline transcript discarded for this account.';
    } catch (cause) {
      error = `The queued transcript could not be discarded: ${friendly(cause)}`;
    }
  }

  function authorizationMessage(move) {
    return {
      gameId: BigInt(move.gameId), rulesetId: move.rulesetId, ply: Number(move.ply),
      prevTranscriptRoot: move.prevTranscriptRoot, fromSquare: Number(move.fromSquare),
      toSquare: Number(move.toSquare), promotion: Number(move.promotion)
    };
  }

  async function verifyQueuedSignatures(moves, snapshot = session, generation = sessionGeneration) {
    validateTranscriptContinuation(moves, game);
    for (let index = 0; index < moves.length; index += 1) {
      const move = moves[index];
      const required = index % 2 === 0
        ? (game.whiteTurn ? game.white : game.black)
        : (game.whiteTurn ? game.black : game.white);
      if (!required || getAddress(move.signer) !== getAddress(required)) throw new Error(`Unexpected signer at ply ${move.ply}.`);
      const message = authorizationMessage(move);
      const valid = await snapshot.publicClient.verifyTypedData({ address: getAddress(move.signer), ...moveTypedData(snapshot.chainId, address, message), signature: move.signature });
      if (!valid) throw new Error(`Invalid EIP-712 signature at ply ${move.ply}.`);
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
    }
  }

  async function importTranscript() {
    resetMessage();
    if (!session) { error = 'Connect a wallet first.'; return; }
    const snapshot = session;
    const generation = sessionGeneration;
    busy = true;
    try {
      const incoming = parseTranscriptJson(importText, { chainId: snapshot.chainId, game: address });
      const currentTranscript = pruneTranscriptBeforePly(transcript, game.ply);
      const incomingTranscript = pruneTranscriptBeforePly(incoming, game.ply);
      const merged = mergeTranscripts(currentTranscript, incomingTranscript);
      validateTranscriptContinuation(merged.moves, game);
      await verifyQueuedSignatures(merged.moves, snapshot, generation);
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      transcript = saveTranscript(localStorage, merged, snapshot.account);
      rebuildDisplayBoard(); importText = '';
      notice = 'Transcript validated and merged. Sign only when this wallet controls the expected player.';
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) error = friendly(cause);
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  async function claimRecord() {
    if (!recordAddress) { error = 'The factory record contract has not been verified.'; return; }
    if (!session) { error = 'Connect a wallet first.'; return; }
    if (!recordActions.canClaim) { error = 'This account cannot claim a record for this game.'; return; }
    const snapshot = session;
    const generation = sessionGeneration;
    let confirmed = false;
    resetMessage(); busy = true;
    try {
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const hash = await snapshot.walletClient.writeContract({ address: recordAddress, abi: recordAbi, functionName: 'claim', args: [address] });
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      await waitForSuccessfulReceipt(snapshot.publicClient, hash);
      confirmed = true;
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      recordClaimed = true;
      recordOwner = snapshot.account;
      recordTokenId = matchRecordTokenId(snapshot.chainId, address, snapshot.account);
      await refreshMatchRecordState(snapshot, generation);
      notice = 'Soulbound match record claimed.';
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) {
        error = confirmed ? `The claim succeeded, but record state could not be refreshed: ${friendly(cause)}` : friendly(cause);
      }
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  async function burnRecord() {
    if (!recordAddress) { error = 'The factory record contract has not been verified.'; return; }
    if (!session) { error = 'Connect a wallet first.'; return; }
    if (!recordActions.canBurn || recordTokenId === null) { error = 'This account does not own an active record for this game.'; return; }
    if (!window.confirm('Permanently burn this match record? It cannot be transferred or claimed again.')) return;
    const snapshot = session;
    const generation = sessionGeneration;
    let confirmed = false;
    resetMessage(); busy = true;
    try {
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      const hash = await snapshot.walletClient.writeContract({
        address: recordAddress, abi: recordAbi, functionName: 'burn', args: [recordTokenId]
      });
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      await waitForSuccessfulReceipt(snapshot.publicClient, hash);
      confirmed = true;
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      recordClaimed = true;
      recordOwner = '';
      await refreshMatchRecordState(snapshot, generation);
      notice = 'Match record burned permanently.';
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) {
        error = confirmed ? `The burn succeeded, but record state could not be refreshed: ${friendly(cause)}` : friendly(cause);
      }
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  function currentDrawAgreement() {
    return validateDrawAgreement(
      drawAgreement ?? createDrawAgreement(session.chainId, address, game),
      { chainId: session.chainId, game: address, state: game }
    );
  }

  async function verifyDrawSignatures(agreement, snapshot = session, generation = sessionGeneration) {
    if (game.status !== 1) throw new Error('Draw agreements are valid only while the game is active.');
    const valid = validateDrawAgreement(agreement, { chainId: snapshot.chainId, game: address, state: game });
    const players = new Set([getAddress(game.white), getAddress(game.black)]);
    for (const entry of valid.signatures) {
      if (!players.has(getAddress(entry.signer))) throw new Error('A draw signature is not from a player in this game.');
      const accepted = await snapshot.publicClient.verifyTypedData({
        address: getAddress(entry.signer),
        ...drawAgreementTypedData(snapshot.chainId, address, valid),
        signature: entry.signature
      });
      if (!accepted) throw new Error(`Invalid draw signature from ${entry.signer}.`);
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
    }
    return valid;
  }

  async function signDrawAgreement() {
    resetMessage();
    if (!session || !isPlayer || game.status !== 1) { error = 'Only an active-game player can sign this draw agreement.'; return; }
    if (queued.length) { error = 'Archive queued moves before signing a draw for the current onchain state.'; return; }
    const snapshot = session;
    const generation = sessionGeneration;
    busy = true;
    try {
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      let agreement = currentDrawAgreement();
      await verifyDrawSignatures(agreement, snapshot, generation);
      const signature = await snapshot.walletClient.signTypedData({
        account: snapshot.account,
        ...drawAgreementTypedData(snapshot.chainId, address, agreement)
      });
      assertSessionCurrent(session, snapshot, sessionGeneration, generation);
      agreement = withDrawSignature(agreement, snapshot.account, signature);
      drawAgreement = agreement;
      notice = agreement.signatures.length === 2 ? 'Both draw signatures are ready to submit.' : 'Draw agreement signed. Export it for the other player.';
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) error = friendly(cause);
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  async function importDrawAgreement() {
    resetMessage();
    if (!session) { error = 'Connect a wallet first.'; return; }
    const snapshot = session;
    const generation = sessionGeneration;
    busy = true;
    try {
      const incoming = parseDrawAgreementJson(drawImportText, { chainId: snapshot.chainId, game: address, state: game });
      const valid = await verifyDrawSignatures(incoming, snapshot, generation);
      if (drawAgreement) {
        const combined = [...drawAgreement.signatures];
        for (const signature of valid.signatures) {
          const existing = combined.find((entry) => getAddress(entry.signer) === getAddress(signature.signer));
          if (existing && existing.signature !== signature.signature) throw new Error(`Conflicting draw signature from ${signature.signer}.`);
          if (!existing) combined.push(signature);
        }
        drawAgreement = validateDrawAgreement({ ...valid, signatures: combined }, { chainId: snapshot.chainId, game: address, state: game });
      } else drawAgreement = valid;
      drawImportText = '';
      notice = 'Draw agreement validated and imported.';
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) error = friendly(cause);
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }

  function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
  }

  function exportDrawAgreement() {
    resetMessage();
    try { downloadJson(currentDrawAgreement(), `queencheck-draw-${address}-${game.ply}.json`); }
    catch (cause) { error = friendly(cause); }
  }

  async function submitDrawAgreement() {
    resetMessage();
    if (!session) { error = 'Connect a wallet first.'; return; }
    const snapshot = session;
    const generation = sessionGeneration;
    busy = true;
    try {
      if (queued.length) throw new Error('Archive queued moves before submitting a draw for the resulting onchain state.');
      const valid = await verifyDrawSignatures(currentDrawAgreement(), snapshot, generation);
      const white = valid.signatures.find((entry) => getAddress(entry.signer) === getAddress(game.white));
      const black = valid.signatures.find((entry) => getAddress(entry.signer) === getAddress(game.black));
      if (!white || !black) throw new Error('Both players must sign the exact current state before submission.');
      await sendWrite('agreeDraw', [white.signature, black.signature], 'Signed draw agreement confirmed.');
    } catch (cause) {
      if (session === snapshot && sessionGeneration === generation) error = friendly(cause);
    }
    finally {
      if (session === snapshot && sessionGeneration === generation) busy = false;
    }
  }
</script>

<section class="game-shell">
  <div class="game-heading">
    <div>
      <a href="/">← Tables</a>
      <span class="eyebrow">Match #{game.gameId === '0' ? '…' : game.gameId}</span>
      <h1>{turnLabel}</h1>
    </div>
    <WalletButton bind:session onconnect={connected} ondisconnect={disconnected} />
  </div>
  {#if loading}<p class="status-box">Checking the onchain board…</p>{/if}
  {#if error}<p class="form-error status-box" role="alert">{error}</p>{/if}
  {#if notice}<p class="success status-box" role="status">{notice}</p>{/if}
  {#if verified}
    {#if !session}
      <div class="spectator-banner" role="status">
        <span><strong>Watching.</strong> This position is read from Base Sepolia. Connect only if you want to sit down and move.</span>
        <button class="secondary" type="button" on:click={() => refresh(null, sessionGeneration)} disabled={loading}>Refresh</button>
      </div>
    {/if}
    <div class="game-grid">
      <div class="table-column">
        <div class="player-strip">
          <div class="seat" class:to-move={!sideToMoveWhite && game.status === 1}>
            <span>Black</span>
            <strong title={game.black}>{game.black && game.black !== zeroAddress ? shortAddress(game.black) : (game.invited && game.invited !== zeroAddress ? `Invited ${shortAddress(game.invited)}` : 'Open seat')}</strong>
          </div>
          <div class="clock-chip">
            {#if game.moveTimeout && game.status === 1}
              <span>{clockLabel || '0:00'}</span>
              <small>{game.timeoutFinalizeAfter ? 'Grace' : 'To move'}</small>
            {:else}
              <span>∞</span>
              <small>Untimed</small>
            {/if}
          </div>
          <div class="seat" class:to-move={sideToMoveWhite && game.status === 1}>
            <span>White</span>
            <strong title={game.white}>{shortAddress(game.white)}</strong>
          </div>
        </div>
        <ChessBoard
          board={displayBoard}
          {selected}
          {flipped}
          lastFrom={lastMove?.from ?? null}
          lastTo={lastMove?.to ?? null}
          {legalSquares}
          {checkSquare}
          disabled={busy || !session || game.status !== 1}
          onselect={selectSquare}
        />
        {#if session && game.status === 1}
          <div class="play-bar">
            <div class="segmented">
              <button type="button" class:active={mode === 'live'} on:click={() => mode = 'live'}>Live</button>
              <button type="button" class:active={mode === 'offline'} on:click={() => mode = 'offline'}>Offline</button>
            </div>
            <label class="promo">Promote to
              <select bind:value={promotion}>
                <option value={5}>Queen</option>
                <option value={4}>Rook</option>
                <option value={3}>Bishop</option>
                <option value={2}>Knight</option>
              </select>
            </label>
            <p>{mode === 'live' ? 'Each move is sent onchain.' : 'Sign here, archive up to 16 moves later.'}</p>
          </div>
        {/if}
      </div>
      <aside class="game-sidebar">
        <div class="panel compact table-card">
          <p class="turn-copy">{turnLabel}. Ply {game.ply}{checkSquare != null ? ' · check' : ''}.</p>
          {#if session}
            <div class="button-grid">
              <button type="button" on:click={() => sendWrite('join')} disabled={busy || !canJoin}>Sit as Black</button>
              <button class="secondary" type="button" on:click={() => sendWrite('cancel')} disabled={busy || game.status !== 0 || game.white.toLowerCase() !== session.account.toLowerCase()}>Cancel challenge</button>
              <button class="secondary" type="button" on:click={() => sendWrite('resign')} disabled={busy || game.status !== 1 || !isPlayer}>Resign</button>
              <button class="secondary" type="button" on:click={() => sendWrite('offerDraw')} disabled={busy || game.status !== 1 || !isPlayer}>Offer draw</button>
              <button class="secondary" type="button" on:click={() => sendWrite('cancelDrawOffer')} disabled={busy || !canCancelDraw}>Withdraw offer</button>
              <button class="secondary" type="button" on:click={() => sendWrite('acceptDraw')} disabled={busy || game.status !== 1 || !isPlayer || !game.drawOfferer || game.drawOfferer.toLowerCase() === session.account.toLowerCase()}>Accept draw</button>
              <button class="secondary" type="button" on:click={() => sendWrite('claimThreefold')} disabled={busy || !canClaimThreefold}>Threefold</button>
              <button class="secondary" type="button" on:click={() => sendWrite('claimFiftyMove')} disabled={busy || !canClaimFifty}>50-move</button>
              <button class="secondary" type="button" on:click={() => sendWrite('signalTimeout')} disabled={busy || !canSignalTimeout}>Flag the clock</button>
              <button class="secondary" type="button" on:click={() => sendWrite('finalizeTimeout')} disabled={busy || !canFinalizeTimeout}>End on time</button>
            </div>
          {:else}
            <p>Connect to join, move, or resign. Spectating never asks for a signature.</p>
          {/if}
        </div>
        {#if session}
          <details class="panel compact">
            <summary>Offline moves <span class="count">{queued.length}</span></summary>
            <p>Export this file for the other player. Archive up to 16 signed plies at a time.</p>
            <div class="button-row">
              <button class="secondary" type="button" on:click={exportTranscript}>Export</button>
              <button class="secondary" type="button" on:click={discardTranscript} disabled={!queued.length || busy}>Discard queue</button>
              <button type="button" on:click={checkpoint} disabled={!queued.length || busy}>Archive {Math.min(queued.length, 16)}</button>
            </div>
            <label>Import transcript<textarea bind:value={importText} maxlength="262144" rows="3" placeholder="Paste transcript JSON"></textarea></label>
            <button class="secondary" type="button" on:click={importTranscript} disabled={!importText || busy}>Validate & import</button>
          </details>
          <details class="panel compact">
            <summary>Signed draw <span class="count">{drawAgreement?.signatures.length ?? 0}/2</span></summary>
            <p>Both players sign this exact position. Any later move voids it.</p>
            <div class="button-row">
              <button class="secondary" type="button" on:click={signDrawAgreement} disabled={busy || !isPlayer || game.status !== 1 || queued.length}>Sign</button>
              <button class="secondary" type="button" on:click={exportDrawAgreement} disabled={game.status !== 1}>Export</button>
              <button type="button" on:click={submitDrawAgreement} disabled={busy || queued.length || (drawAgreement?.signatures.length ?? 0) !== 2}>Submit</button>
            </div>
            <label>Import agreement<textarea bind:value={drawImportText} maxlength="16384" rows="3" placeholder="Paste draw JSON"></textarea></label>
            <button class="secondary" type="button" on:click={importDrawAgreement} disabled={!drawImportText || busy}>Validate & import</button>
          </details>
          <div class="panel compact record">
            <h2>Match record</h2>
            <p>Optional, soulbound, burnable. No prize, token, or financial right.</p>
            {#if recordActions.canClaim}<button type="button" on:click={claimRecord} disabled={busy || !recordAddress}>Claim record</button>
            {:else if recordActions.canBurn}<button class="secondary" type="button" on:click={burnRecord} disabled={busy || !recordAddress}>Burn record</button>
            {:else if recordClaimed}<p>This account already burned its record for this game.</p>{/if}
          </div>
        {/if}
        <details class="panel compact">
          <summary>Onchain proof</summary>
          <div class="stat-row"><span>Status</span><strong>{statusLabels[game.status] ?? `State ${game.status}`}</strong></div>
          <div class="stat-row"><span>White</span><code>{game.white}</code></div>
          <div class="stat-row"><span>Black</span><code>{game.black}</code></div>
          <div class="stat-row"><span>State hash</span><code>{game.stateHash}</code></div>
          <div class="stat-row"><span>Transcript</span><code>{game.transcriptRoot}</code></div>
        </details>
      </aside>
    </div>
  {/if}
</section>
