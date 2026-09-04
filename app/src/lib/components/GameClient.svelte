<script>
  import { env } from '$env/dynamic/public';
  import { Chess } from 'chess.js';
  import { ContractFunctionRevertedError, getAddress } from 'viem';
  import { onMount } from 'svelte';
  import ChessBoard from './ChessBoard.svelte';
  import WalletButton from './WalletButton.svelte';
  import { boardToFen, chessToSignedBoard, EMPTY_BOARD, indexToAlgebraic } from '$lib/board.js';
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
  let game = {
    white: '', black: '', status: 0, whiteTurn: true, ply: 0, gameId: '0', rulesetId: '',
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

  onMount(() => {
    void refresh(null, sessionGeneration);
    return () => {
      refreshGeneration += 1;
      sessionGeneration += 1;
    };
  });

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
      const [white, black, status, whiteTurn, ply, gameId, rulesetId, stateHash, transcriptRoot, castlingFlags, enPassantCol, enPassantRow, halfmoveClock, moveTimeout, turnDeadline, timeoutFinalizeAfter, drawOfferer, rawBoard] = await Promise.all([
        ...['whitePlayer', 'blackPlayer', 'status', 'whiteTurn', 'ply', 'gameId', 'rulesetId', 'stateHash', 'transcriptRoot', 'castlingFlags', 'enPassantCol', 'enPassantRow', 'halfmoveClock', 'moveTimeout', 'turnDeadline', 'timeoutFinalizeAfter', 'drawOfferer', 'getBoard'].map((functionName) => reader.publicClient.readContract({ address, abi: gameAbi, functionName }))
      ]);
      const nextGame = {
        white, black, status: Number(status), whiteTurn, ply: Number(ply), gameId: String(gameId),
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
        await sendWrite('play', [from, index, promotionValue], 'Move confirmed. The onchain SVG is now updated.');
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
  <div class="game-heading"><div><a href="/">← Home</a><span class="eyebrow">Verified match</span><h1>Game {address.slice(0, 8)}…{address.slice(-6)}</h1></div><WalletButton bind:session onconnect={connected} ondisconnect={disconnected} /></div>
  {#if loading}<p class="status-box">Verifying bytecode and factory registration…</p>{/if}
  {#if error}<p class="form-error status-box" role="alert">{error}</p>{/if}
  {#if notice}<p class="success status-box" role="status">{notice}</p>{/if}
  {#if verified}
    {#if !session}<div class="spectator-banner" role="status"><span><strong>Verified spectator mode.</strong> This board and state were read from Base Sepolia without requesting wallet access.</span><button class="secondary" type="button" on:click={() => refresh(null, sessionGeneration)} disabled={loading}>Refresh state</button></div>{/if}
    <div class="game-grid">
      <ChessBoard board={displayBoard} {selected} disabled={busy || !session} onselect={selectSquare} />
      <aside class="game-sidebar">
        <div class="panel compact"><div class="stat-row"><span>Status</span><strong>{statusLabels[game.status] ?? `State ${game.status}`}</strong></div><div class="stat-row"><span>Ply</span><strong>{game.ply}</strong></div><div class="stat-row"><span>White</span><code>{game.white}</code></div><div class="stat-row"><span>Black</span><code>{game.black}</code></div><div class="stat-row"><span>State hash</span><code>{game.stateHash}</code></div><div class="stat-row"><span>Transcript root</span><code>{game.transcriptRoot}</code></div></div>
        {#if session}
          <div class="panel compact">
            <h2>Move mode</h2><div class="segmented"><button class:active={mode === 'live'} on:click={() => mode = 'live'}>Live</button><button class:active={mode === 'offline'} on:click={() => mode = 'offline'}>Offline</button></div>
            <p>{mode === 'live' ? 'Each move is sent onchain immediately and updates the SVG.' : 'Moves are signed locally. Nothing is archived until checkpoint is submitted.'}</p>
            <label>Promotion<select bind:value={promotion}><option value={5}>Queen</option><option value={4}>Rook</option><option value={3}>Bishop</option><option value={2}>Knight</option></select></label>
          </div>
          <div class="panel compact"><h2>Game actions</h2><div class="button-grid"><button on:click={() => sendWrite('join')} disabled={busy || game.status !== 0}>Join / accept</button><button class="secondary" on:click={() => sendWrite('cancel')} disabled={busy || game.status !== 0 || game.white.toLowerCase() !== session.account.toLowerCase()}>Cancel</button><button class="secondary" on:click={() => sendWrite('resign')} disabled={busy || game.status !== 1 || !isPlayer}>Resign</button><button class="secondary" on:click={() => sendWrite('offerDraw')} disabled={busy || game.status !== 1 || !isPlayer}>Offer draw</button><button class="secondary" on:click={() => sendWrite('cancelDrawOffer')} disabled={busy || !canCancelDraw}>Cancel draw offer</button><button class="secondary" on:click={() => sendWrite('acceptDraw')} disabled={busy || game.status !== 1 || !isPlayer || !game.drawOfferer || game.drawOfferer.toLowerCase() === session.account.toLowerCase()}>Accept draw</button><button class="secondary" on:click={() => sendWrite('claimThreefold')} disabled={busy || !canClaimThreefold}>Claim threefold</button><button class="secondary" on:click={() => sendWrite('claimFiftyMove')} disabled={busy || !canClaimFifty}>Claim 50-move draw</button><button class="secondary" on:click={() => sendWrite('signalTimeout')} disabled={busy || game.status !== 1 || !isPlayer || !game.moveTimeout}>Signal timeout</button><button class="secondary" on:click={() => sendWrite('finalizeTimeout')} disabled={busy || !game.timeoutFinalizeAfter}>Finalize timeout</button></div>{#if game.moveTimeout}<p>Turn deadline: {new Date(game.turnDeadline * 1000).toLocaleString()}. {game.timeoutFinalizeAfter ? `Grace ends ${new Date(game.timeoutFinalizeAfter * 1000).toLocaleString()}.` : ''}</p>{/if}</div>
          <div class="panel compact"><h2>Offline transcript <span class="count">{queued.length}</span></h2><p>Up to 16 signed moves per checkpoint. A different player/browser must import this file and add its own signature; QueenCheck does not claim automatic P2P sync.</p><div class="button-row"><button class="secondary" on:click={exportTranscript}>Export JSON</button><button class="secondary" on:click={discardTranscript} disabled={!queued.length || busy}>Discard queued</button><button on:click={checkpoint} disabled={!queued.length || busy}>Archive {Math.min(queued.length, 16)}</button></div><label>Import signed transcript<textarea bind:value={importText} maxlength="262144" rows="4" placeholder="Paste QueenCheck transcript JSON"></textarea></label><button class="secondary" on:click={importTranscript} disabled={!importText}>Validate & import</button></div>
          <div class="panel compact"><h2>Signed draw agreement <span class="count">{drawAgreement?.signatures.length ?? 0}/2</span></h2><p>Both players sign the exact current onchain state. Any move makes an old agreement unusable.</p><div class="button-row"><button class="secondary" on:click={signDrawAgreement} disabled={busy || !isPlayer || game.status !== 1 || queued.length}>Sign current state</button><button class="secondary" on:click={exportDrawAgreement} disabled={game.status !== 1}>Export JSON</button><button on:click={submitDrawAgreement} disabled={busy || queued.length || (drawAgreement?.signatures.length ?? 0) !== 2}>Submit draw</button></div><label>Import signed draw agreement<textarea bind:value={drawImportText} maxlength="16384" rows="4" placeholder="Paste QueenCheck draw agreement JSON"></textarea></label><button class="secondary" on:click={importDrawAgreement} disabled={!drawImportText || busy}>Validate & import</button></div>
          <div class="panel compact record"><h2>Optional match record</h2><p>The record NFT mirrors the latest archived SVG. It is opt-in, soulbound, burnable, and grants no token, prize, revenue, governance, or other economic right. Its address is read from and verified against the configured factory.</p>{#if recordActions.canClaim}<button on:click={claimRecord} disabled={busy || !recordAddress}>Claim record</button>{:else if recordActions.canBurn}<button class="secondary" on:click={burnRecord} disabled={busy || !recordAddress}>Burn record</button>{:else if recordClaimed}<p>This account's record was burned and cannot be claimed again.</p>{/if}</div>
        {:else}
          <div class="panel compact"><h2>Read-only view</h2><p>Connect only if you want to join this game or sign an action. Spectating never requests an account or signature.</p></div>
          <div class="panel compact record"><h2>Optional match record</h2><p>Players can claim a soulbound, burnable record whose SVG follows the latest archived onchain position. It carries no financial rights.</p></div>
        {/if}
      </aside>
    </div>
  {/if}
</section>
