const socket = io();
const chess = new Chess();
const boardElement = document.querySelector(".chessboard");
// Initialize mode before first render to avoid stale flip state
const initialModeEl = document.getElementById("mode");
let initialMode = initialModeEl ? initialModeEl.value : '';

let draggedPiece = null;
let sourceSquare = null;
let playerRole = null;
let pendingPromotion = null; // { from, to, color }
let selfMode = initialMode === 'self';
let selectedSquare = null; // { row, col }

function rcToAlg(row, col) {
    return `${String.fromCharCode(97 + col)}${8 - row}`;
}

function algToRc(alg) {
    return { row: 8 - parseInt(alg[1], 10), col: alg.charCodeAt(0) - 97 };
}

function clearHighlights() {
    const hints = boardElement.querySelectorAll('.hint, .hint-capture');
    hints.forEach((el) => {
        el.classList.remove('hint');
        el.classList.remove('hint-capture');
    });
}

function highlightMoves(fromAlg) {
    clearHighlights();
    const moves = chess.moves({ square: fromAlg, verbose: true });
    moves.forEach((m) => {
        const { row, col } = algToRc(m.to);
        const sel = boardElement.querySelector(`.square[data-row="${row}"][data-col="${col}"]`);
        if (!sel) return;
        if (m.flags && (m.flags.includes('c') || m.flags.includes('e'))) sel.classList.add('hint-capture');
        else sel.classList.add('hint');
    });
}

/* ------------------ Helper Functions ------------------ */

// Get unicode for chess pieces
const getPieceUnicode = (piece) => {
    const whitePieces = {
        p: "♙",
        r: "♖",
        n: "♘",
        b: "♗",
        q: "♕",
        k: "♔"
    };
    const blackPieces = {
        p: "♟",
        r: "♜",
        n: "♞",
        b: "♝",
        q: "♛",
        k: "♚"
    };
    return piece.color === 'w' ? whitePieces[piece.type] : blackPieces[piece.type];
};


// Handle move (emit to server) with promotion selection
const handleMove = async (source, target) => {
    const from = `${String.fromCharCode(97 + source.col)}${8 - source.row}`;
    const to = `${String.fromCharCode(97 + target.col)}${8 - target.row}`;

    // Only consider legal moves from this square
    const legalFrom = chess.moves({ square: from, verbose: true });
    if (!legalFrom || legalFrom.length === 0) return;
    const targetMove = legalFrom.find((m) => m.to === to);
    if (!targetMove) return; // not a legal destination

    let promotion = targetMove.promotion || undefined;
    
    // FIXED: Check if it's a promotion move (pawn reaching last rank)
    if (targetMove.flags && targetMove.flags.includes('p')) {
        // Ask player to choose piece for promotion
        const piece = chess.get(from);
        promotion = await choosePromotion(piece && piece.color ? piece.color : 'w');
    }

    const move = { from, to };
    if (promotion) move.promotion = promotion;

    // Final local validation
    const attempted = chess.move(move);
    if (!attempted) return;
    chess.undo();

    socket.emit("move", move);
};

// Show promotion chooser and resolve to selected piece type
function choosePromotion(color) {
    return new Promise((resolve) => {
        const modal = document.getElementById('promotionModal');
        const overlay = document.getElementById('promotionOverlay');
        if (!modal || !overlay) return resolve('q');
        modal.style.display = 'block';
        overlay.style.display = 'block';
        const handler = (e) => {
            const val = e.target && e.target.getAttribute('data-piece');
            if (!val) return;
            cleanup();
            resolve(val);
        };
        function cleanup() {
            modal.style.display = 'none';
            overlay.style.display = 'none';
            ['q','r','b','n'].forEach((p) => {
                const btn = document.querySelector(`.promote-btn[data-piece="${p}"]`);
                if (btn) btn.removeEventListener('click', handler);
            });
        }
        ['q','r','b','n'].forEach((p) => {
            const btn = document.querySelector(`.promote-btn[data-piece="${p}"]`);
            if (btn) btn.addEventListener('click', handler);
        });
    });
}

/* ------------------ Game Over UI Helper ------------------ */
function showGameOverOverlayWithMessage(message) {
    // Clean up any previous overlays or legacy in-board messages
    const existingWrapper = document.querySelector('.game-over-wrapper');
    if (existingWrapper) existingWrapper.remove();
    const existingOverlay = document.querySelector('.game-over-overlay');
    if (existingOverlay) existingOverlay.remove();
    const legacyInBoard = document.querySelector('.game-result');
    if (legacyInBoard) legacyInBoard.remove();

    const overlay = document.createElement('div');
    overlay.className = 'game-over-overlay';
    overlay.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        background: rgba(0, 0, 0, 0.9);
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 999999 !important;
        backdrop-filter: blur(4px);
        transform: none !important;
        pointer-events: auto !important;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
        background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
        color: white;
        padding: 40px 48px;
        border-radius: 20px;
        min-width: 400px;
        text-align: center;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
        border: 2px solid rgba(255, 255, 255, 0.1);
        transform: none !important;
        direction: ltr !important;
        writing-mode: horizontal-tb !important;
    `;

    const title = document.createElement('div');
    title.textContent = message || 'Game Over';
    title.style.cssText = `
        font-weight: 900;
        font-size: 36px;
        margin-bottom: 32px;
        color: #fff;
        letter-spacing: 1px;
        text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
        transform: none !important;
        direction: ltr !important;
        unicode-bidi: bidi-override !important;
        writing-mode: horizontal-tb !important;
        text-orientation: mixed !important;
    `;
    panel.appendChild(title);

    const actions = document.createElement('div');
    actions.style.cssText = `
        display: flex;
        gap: 16px;
        justify-content: center;
        margin-top: 24px;
        transform: none !important;
        direction: ltr !important;
    `;

    function addButton(label, onClick, bgColor) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = `
            padding: 16px 32px;
            border-radius: 12px;
            font-weight: 700;
            font-size: 18px;
            background: ${bgColor};
            color: white;
            border: none;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
            min-width: 140px;
            transform: none !important;
            direction: ltr !important;
            writing-mode: horizontal-tb !important;
        `;
        btn.onmouseover = () => {
            btn.style.transform = 'translateY(-3px) scale(1.05)';
            btn.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.5)';
        };
        btn.onmouseout = () => {
            btn.style.transform = 'translateY(0) scale(1)';
            btn.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.4)';
        };
        btn.onclick = onClick;
        actions.appendChild(btn);
    }

    addButton('Play Again', () => {
        const wrapperEl = document.querySelector('.game-over-wrapper');
        if (wrapperEl) wrapperEl.remove();
        const quitBtnEl = document.getElementById('quitBtn');
        if (quitBtnEl) {
            quitBtnEl.disabled = false;
            quitBtnEl.style.opacity = '1';
            quitBtnEl.style.cursor = 'pointer';
        }
        socket.emit('resetGame');
    }, '#10b981');

    addButton('Home', () => {
        window.location.href = '/';
    }, '#ef4444');

    panel.appendChild(actions);
    overlay.appendChild(panel);

    const overlayWrapper = document.createElement('div');
    overlayWrapper.className = 'game-over-wrapper';
    overlayWrapper.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        z-index: 999999 !important;
        transform: none !important;
        pointer-events: auto !important;
    `;
    overlayWrapper.appendChild(overlay);
    document.body.appendChild(overlayWrapper);
}

/* ------------------ Game Over Check (Client Side) ------------------ */
const checkGameOver = () => {
    // Check using multiple methods for compatibility
    let gameOver = false;
    if (typeof chess.isGameOver === 'function') {
        gameOver = chess.isGameOver();
    } else if (typeof chess.game_over === 'function') {
        gameOver = chess.game_over();
    } else if (typeof chess.gameOver === 'function') {
        gameOver = chess.gameOver();
    } else {
        gameOver = chess.moves().length === 0;
    }

    if (!gameOver) return;

    // Derive reason and winner locally as a fallback if server didn't emit gameOver yet
    let winner = null; // 'w' | 'b' | 'draw'
    let reason = 'game_over';
    if (chess.in_checkmate && chess.in_checkmate()) {
        winner = chess.turn() === 'w' ? 'b' : 'w';
        reason = 'checkmate';
    } else if (chess.in_stalemate && chess.in_stalemate()) {
        winner = 'draw';
        reason = 'stalemate';
    } else if ((chess.in_threefold_repetition && chess.in_threefold_repetition()) ||
               (chess.insufficient_material && chess.insufficient_material()) ||
               (chess.in_draw && chess.in_draw())) {
        winner = 'draw';
        reason = 'draw';
    }

    const modeEl = document.getElementById('mode');
    const mode = modeEl ? modeEl.value : '';

    let message = 'Game Over';
    if (winner === 'draw') {
        message = reason === 'stalemate' ? 'Stalemate - Draw!' : 'Draw!';
    } else if (mode === 'bot') {
        message = (winner === playerRole) ? 'You win!' : 'Bot wins!';
    } else if (mode === 'self') {
        if (reason === 'checkmate') message = winner === 'w' ? 'White wins by checkmate!' : 'Black wins by checkmate!';
        else message = winner === 'w' ? 'White wins!' : 'Black wins!';
    } else if (winner) {
        // friends/online fallback
        message = (winner === playerRole) ? 'Checkmate! You win!' : 'Checkmate! You lost!';
    }

    showGameOverOverlayWithMessage(message);
};

/* ------------------ Turn Indicator (Missing Function) ------------------ */
function updateTurnIndicator() {
    // Optional: Add visual indicator for whose turn it is
    const turnText = chess.turn() === 'w' ? "White's turn" : "Black's turn";
    console.log(turnText);
}

/* ------------------ Render Board ------------------ */
document.addEventListener('DOMContentLoaded', function() {
    const modeInput = document.getElementById('mode');
    if (modeInput) {
        modeInput.addEventListener('change', function() {
            window.location.search = `?mode=${modeInput.value}`;
        });
    }
});

const renderBoard = () => {
    const board = chess.board();
    boardElement.innerHTML = "";

    board.forEach((row, rowindex) => {
        row.forEach((square, squareindex) => {
            const squareElement = document.createElement("div");
            squareElement.classList.add(
                "square",
                (rowindex + squareindex) % 2 === 0 ? "light" : "dark"
            );

            squareElement.dataset.row = rowindex;
            squareElement.dataset.col = squareindex;

            if (square) {
                const pieceElement = document.createElement("div");
                pieceElement.classList.add(
                    "piece",
                    square.color === 'w' ? "white" : "black"
                );
                pieceElement.innerText = getPieceUnicode(square);
                const canDrag = selfMode
                    ? true
                    : (initialMode === 'bot'
                        ? (playerRole === square.color)
                        : (playerRole === square.color));
                pieceElement.draggable = canDrag;

                if (pieceElement.draggable) {
                    pieceElement.style.cursor = "grab";
                } else {
                    pieceElement.style.cursor = "default";
                }
                pieceElement.addEventListener("dragstart", (e) => {
                    if (pieceElement.draggable) {
                        draggedPiece = pieceElement;
                        sourceSquare = { row: rowindex, col: squareindex };
                        highlightMoves(rcToAlg(rowindex, squareindex));
                        pieceElement.classList.add("dragging");
                        e.dataTransfer.setData("text/plain", "");
                        e.dataTransfer.setDragImage(pieceElement, 20, 20);
                    }
                });

                pieceElement.addEventListener("dragend", () => {
                    draggedPiece.classList.remove("dragging");
                    draggedPiece = null;
                    sourceSquare = null;
                    selectedSquare = null;
                    clearHighlights();
                });

                pieceElement.addEventListener('click', () => {
                    if (!pieceElement.draggable) return;
                    if (!selectedSquare || selectedSquare.row !== rowindex || selectedSquare.col !== squareindex) {
                        selectedSquare = { row: rowindex, col: squareindex };
                        highlightMoves(rcToAlg(rowindex, squareindex));
                    } else {
                        selectedSquare = null;
                        clearHighlights();
                    }
                });

                squareElement.appendChild(pieceElement);
            }

            squareElement.addEventListener("dragover", (e) => {
                e.preventDefault()
                squareElement.classList.add("drag-over");
            });

            squareElement.addEventListener("dragleave", () => {
                squareElement.classList.remove("drag-over");
            });

            squareElement.addEventListener("drop", (e) => {
                e.preventDefault();
                squareElement.classList.remove("drag-over");
                if (draggedPiece) {
                    const targetSquare = {
                        row: parseInt(squareElement.dataset.row),
                        col: parseInt(squareElement.dataset.col),
                    };
                    handleMove(sourceSquare, targetSquare);
                }
                clearHighlights();
            });

            squareElement.addEventListener('click', () => {
                if (!selectedSquare) return;
                const targetSquare = {
                    row: parseInt(squareElement.dataset.row),
                    col: parseInt(squareElement.dataset.col),
                };
                handleMove(selectedSquare, targetSquare);
                selectedSquare = null;
                clearHighlights();
            });

            boardElement.appendChild(squareElement);
        });
    });

    // Highlight checked king's square in red (side to move)
    try {
        const inCheck = (typeof chess.in_check === 'function') ? chess.in_check() : (typeof chess.inCheck === 'function' ? chess.inCheck() : false);
        if (inCheck) {
            const turnColor = chess.turn();
            let kingRow = -1, kingCol = -1;
            for (let r = 0; r < 8; r++) {
                for (let c = 0; c < 8; c++) {
                    const p = board[r][c];
                    if (p && p.type === 'k' && p.color === turnColor) {
                        kingRow = r;
                        kingCol = c;
                        break;
                    }
                }
                if (kingRow !== -1) break;
            }
            if (kingRow !== -1) {
                const kingSq = boardElement.querySelector(`.square[data-row="${kingRow}"][data-col="${kingCol}"]`);
                if (kingSq) kingSq.classList.add('in-check');
            }
        }
    } catch (e) {
        console.warn('Check highlight failed:', e);
    }

    const shouldFlip = (playerRole === 'b');
    if (shouldFlip) {
        boardElement.classList.add("flipped");
    } else {
        boardElement.classList.remove("flipped");
    }
};

/* ------------------ Socket Events ------------------ */

// Debug: Log ALL socket events
socket.onAny((eventName, ...args) => {
    console.log(`📩 Socket event: ${eventName}`, args);
});

socket.on("playerRole", (role) => {
    playerRole = role;
    renderBoard();
});

socket.on("spectatorRole", () => {
    playerRole = null;
    renderBoard();
});

socket.on("boardState", (fen) => {
    chess.load(fen);
    renderBoard();
    checkGameOver(); // Check for game over when board state updates
});

socket.on("connect", () => {
    if (document.getElementById("mode")?.value === 'friends') {
        try { localStorage.removeItem('chess_username'); } catch {}
    }
    const usernameEl = document.getElementById("username");
    const modeEl = document.getElementById("mode");
    const gameIdEl = document.getElementById("gameId");
    
    let stored = null;
    try { stored = localStorage.getItem('chess_username'); } catch {}
    const provided = usernameEl && usernameEl.value && usernameEl.value.trim().length > 0;
    let nameToUse = stored && stored.trim().length > 0 ? stored : (provided ? usernameEl.value.trim() : null);
    if (!nameToUse) {
        const entered = prompt("Enter your name to show to your opponent:");
        if (entered && entered.trim().length > 0) {
            nameToUse = entered.trim();
        } else {
            return;
        }
    }
    try { localStorage.setItem('chess_username', nameToUse); } catch {}
    if (usernameEl) usernameEl.value = nameToUse;
    const youName = document.getElementById('youName');
    if (youName && nameToUse) youName.textContent = nameToUse;
    
    if (modeEl && modeEl.value === 'bot') {
        socket.emit('setMode', 'bot');
        socket.emit("setUsername", nameToUse);
    } else if (modeEl && modeEl.value === 'self') {
        selfMode = true;
        socket.emit('setMode', 'self');
        socket.emit("setUsername", nameToUse);
    } else if (modeEl && modeEl.value === 'friends' && gameIdEl && gameIdEl.value) {
        selfMode = false;
        socket.emit("setUsername", nameToUse);
        setTimeout(() => {
            socket.emit('joinRoom', { gameId: gameIdEl.value });
        }, 300);
    } else {
        socket.emit("setUsername", nameToUse);
    }
    if (playerRole) {
        socket.emit("reconnectPlayer", playerRole);
    }
});

socket.on("playersUpdate", ({ white, black }) => {
    const status = document.getElementById("playersStatus");
    
    window.whitePlayerName = white;
    window.blackPlayerName = black;
    
    const topName = document.getElementById('blackNameTop');
    const bottomName = document.getElementById('whiteNameBottom');
    
    if (topName && bottomName && white && black) {
        if (playerRole === 'w') {
            bottomName.textContent = `${white} (White) - You`;
            topName.textContent = `${black} (Black) - Opponent`;
        } else if (playerRole === 'b') {
            bottomName.textContent = `${black} (Black) - You`;
            topName.textContent = `${white} (White) - Opponent`;
        }
        
        bottomName.style.cssText = 'color: #4CAF50; font-weight: bold; font-size: 14px; text-align: center;';
        topName.style.cssText = 'color: #999; font-weight: normal; font-size: 14px; text-align: center;';
    }
    
    if (status) {
        status.style.display = 'none';
    }
});

socket.on("opponentDisconnectCountdown", ({ opponent, seconds }) => {
    const el = document.getElementById('disconnectTimer');
    if (!el) return;
    if (seconds <= 0) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    const oppName = opponent === 'w' ? 'White' : 'Black';
    el.textContent = `${oppName} disconnected. Declaring opponent winner in ${seconds}s...`;
    el.style.position = 'relative';
    el.style.padding = '8px 12px';
    el.style.background = 'rgba(0,0,0,0.6)';
    el.style.borderRadius = '8px';
    el.style.display = 'block';
});

socket.on("error", (message) => {
    if (message.includes("username")) {
        const entered = prompt("Please enter your username to join the game:");
        if (entered && entered.trim().length > 0) {
            const finalName = entered.trim();
            try { localStorage.setItem('chess_username', finalName); } catch {}
            socket.emit("setUsername", finalName);
            
            const gameIdEl = document.getElementById("gameId");
            if (gameIdEl && gameIdEl.value) {
                setTimeout(() => {
                    socket.emit('joinRoom', { gameId: gameIdEl.value });
                }, 100);
            }
        }
    } else {
        alert(message);
    }
});

socket.on("gameOver", ({ winner, reason }) => {
    console.log('=== GAME OVER EVENT RECEIVED ===');
    console.log('Winner:', winner);
    console.log('Reason:', reason);
    console.log('Player role:', playerRole);
    
    const modeEl = document.getElementById('mode');
    const mode = modeEl ? modeEl.value : '';
    console.log('Mode:', mode);

    // Disable quit button after game ends
    const quitBtn = document.getElementById('quitBtn');
    if (quitBtn) {
        quitBtn.disabled = true;
        quitBtn.style.opacity = '0.5';
        quitBtn.style.cursor = 'not-allowed';
    }

    let message = "";
    
    if (winner === 'draw') {
        message = reason === 'stalemate' ? 'Stalemate - Draw!' : 'Draw!';
    } else if (mode === "bot") {
        message = (winner === playerRole) ? "You win!" : "Bot wins!";
    } else if (mode === "self") {
        if (reason === "resign") {
            message = winner === "w" ? "White wins! (Black resigned)" : "Black wins! (White resigned)";
        } else if (reason === "checkmate") {
            message = winner === "w" ? "White wins by checkmate!" : "Black wins by checkmate!";
        } else {
            message = winner === "w" ? "White wins!" : "Black wins!";
        }
    } else {
        if (reason === "opponent_disconnected") {
            message = (playerRole === winner) ? "Opponent disconnected. You win!" : "You disconnected. You lost!";
        } else if (reason === 'resign') {
            message = (playerRole === winner) ? "Opponent resigned. You win!" : "You resigned.";
        } else if (reason === 'checkmate') {
            message = (playerRole === winner) ? "Checkmate! You win!" : "Checkmate! You lost!";
        } else {
            message = "Game Over";
        }
    }
    
    console.log('Message:', message);
    
    showGameOverOverlayWithMessage(message);
});

socket.on("move", (move) => {
    console.log('📨 Received move:', move);
    try {
        const result = chess.move(move);
        if (result) {
            console.log('✅ Move applied successfully');
            renderBoard();
            checkGameOver();
            updateTurnIndicator();
        } else {
            console.error('❌ Failed to apply move:', move);
        }
    } catch (error) {
        console.error('❌ Error applying move:', error, move);
    }
});

socket.on("hideLink", () => {
    const linkBox = document.getElementById("shareLinkBox");
    if (linkBox) linkBox.style.display = "none";
});

socket.on("startGame", () => {
    renderBoard();
});

socket.on("waiting", (msg) => {
    console.log(msg);
});

/* ------------------ Initial Render ------------------ */
renderBoard();

// Quit button -> resign OR go home if game ended
const quitBtn = document.getElementById('quitBtn');
if (quitBtn) {
    quitBtn.addEventListener('click', () => {
        // Check if game is already over
        let gameOver = false;
        if (typeof chess.isGameOver === 'function') {
            gameOver = chess.isGameOver();
        } else if (typeof chess.game_over === 'function') {
            gameOver = chess.game_over();
        } else if (typeof chess.gameOver === 'function') {
            gameOver = chess.gameOver();
        } else {
            gameOver = chess.moves().length === 0;
        }
        
        // If game is over, go directly to home
        if (gameOver) {
            window.location.href = '/';
            return;
        }
        
        const modeEl = document.getElementById('mode');
        const mode = modeEl ? modeEl.value : '';
        
        // For self mode, ask which side is resigning
        if (mode === 'self') {
            const currentTurn = chess.turn();
            const turnName = currentTurn === 'w' ? 'White' : 'Black';
            if (!confirm(`${turnName} wants to resign. Are you sure?`)) return;
            // Send which side is resigning
            socket.emit('resign', { resigningAs: currentTurn });
        } else {
            if (!playerRole) {
                window.location.href = '/';
                return;
            }
            if (!confirm('Are you sure you want to resign?')) return;
            socket.emit('resign', {});
        }
    });
}