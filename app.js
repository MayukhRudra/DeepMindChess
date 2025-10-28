const express = require("express");
const socket = require("socket.io");
const http = require("http");
const { Chess } = require("chess.js");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const cors = require("cors");
const { exec } = require('child_process');
const os = require('os');

const app = express();

// Determine LAN base URL to share with friends on the same network
let BASE_URL = null;
function getLanAddress() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return '127.0.0.1';
}

// CORS for online hosting
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const corsOptions = {
    // If ALLOWED_ORIGINS provided, use it; else reflect request origin (supports credentials)
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

const server = http.createServer(app);
const io = socket(server, {
    cors: {
        // Reflect request origin when no ALLOWED_ORIGINS provided (supports credentials)
        origin: allowedOrigins.length ? allowedOrigins : true,
        methods: ["GET", "POST"],
        credentials: true
    }
});

const chess = new Chess();
let players = {};
let currentPlayer = "w";
let lastPlayerWasWhite = false;

let disconnectTimers = {};
let rooms = {};
let botMode = false;
let selfMode = false;
let botDifficulty = 'medium'; // Default difficulty

// ==================== SMART BOT AI WITH MINIMAX ====================

function evaluateBoard(chessInstance) {
    const pieceValues = {
        p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000
    };
    
    const pawnTable = [
        [0,  0,  0,  0,  0,  0,  0,  0],
        [50, 50, 50, 50, 50, 50, 50, 50],
        [10, 10, 20, 30, 30, 20, 10, 10],
        [5,  5, 10, 25, 25, 10,  5,  5],
        [0,  0,  0, 20, 20,  0,  0,  0],
        [5, -5,-10,  0,  0,-10, -5,  5],
        [5, 10, 10,-20,-20, 10, 10,  5],
        [0,  0,  0,  0,  0,  0,  0,  0]
    ];
    
    const knightTable = [
        [-50,-40,-30,-30,-30,-30,-40,-50],
        [-40,-20,  0,  0,  0,  0,-20,-40],
        [-30,  0, 10, 15, 15, 10,  0,-30],
        [-30,  5, 15, 20, 20, 15,  5,-30],
        [-30,  0, 15, 20, 20, 15,  0,-30],
        [-30,  5, 10, 15, 15, 10,  5,-30],
        [-40,-20,  0,  5,  5,  0,-20,-40],
        [-50,-40,-30,-30,-30,-30,-40,-50]
    ];
    
    let score = 0;
    const board = chessInstance.board();
    
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const piece = board[row][col];
            if (piece) {
                let value = pieceValues[piece.type];
                
                // Add positional bonus
                if (piece.type === 'p') {
                    value += piece.color === 'w' 
                        ? pawnTable[row][col] 
                        : pawnTable[7-row][col];
                } else if (piece.type === 'n') {
                    value += piece.color === 'w' 
                        ? knightTable[row][col] 
                        : knightTable[7-row][col];
                }
                
                score += piece.color === 'w' ? value : -value;
            }
        }
    }
    
    return score;
}

function minimax(chessInstance, depth, alpha, beta, maximizingPlayer) {
    if (depth === 0 || isGameOver(chessInstance)) {
        return evaluateBoard(chessInstance);
    }
    
    const moves = chessInstance.moves({ verbose: true });
    
    // No moves available = game over
    if (moves.length === 0) {
        return evaluateBoard(chessInstance);
    }
    
    if (maximizingPlayer) {
        let maxEval = -Infinity;
        for (const move of moves) {
            chessInstance.move(move);
            const evaluation = minimax(chessInstance, depth - 1, alpha, beta, false);
            chessInstance.undo();
            maxEval = Math.max(maxEval, evaluation);
            alpha = Math.max(alpha, evaluation);
            if (beta <= alpha) break; // Alpha-beta pruning
        }
        return maxEval;
    } else {
        let minEval = Infinity;
        for (const move of moves) {
            chessInstance.move(move);
            const evaluation = minimax(chessInstance, depth - 1, alpha, beta, true);
            chessInstance.undo();
            minEval = Math.min(minEval, evaluation);
            beta = Math.min(beta, evaluation);
            if (beta <= alpha) break; // Alpha-beta pruning
        }
        return minEval;
    }
}

function getBestMove(chessInstance, difficulty) {
    const moves = chessInstance.moves({ verbose: true });
    if (moves.length === 0) return null;
    
    // OPTIMIZED DEPTHS - Further reduced for real-time play
    const depths = {
        easy: 1,      // Instant
        medium: 1,    // Fast
        hard: 2,      // Good balance
        expert: 2     // Smart but fast (was 3)
    };
    
    const depth = depths[difficulty] || 1;
    const isMaximizing = chessInstance.turn() === 'w';
    
    let bestMove = null;
    let bestValue = isMaximizing ? -Infinity : Infinity;
    
    // Shuffle moves to add variety
    const shuffledMoves = [...moves].sort(() => Math.random() - 0.5);
    
    // OPTIMIZATION: Limit number of moves to evaluate for expert
    const maxMovesToEvaluate = difficulty === 'expert' ? 20 : moves.length;
    const movesToEvaluate = shuffledMoves.slice(0, maxMovesToEvaluate);
    
    for (const move of movesToEvaluate) {
        chessInstance.move(move);
        const value = minimax(chessInstance, depth - 1, -Infinity, Infinity, !isMaximizing);
        chessInstance.undo();
        
        if ((isMaximizing && value > bestValue) || (!isMaximizing && value < bestValue)) {
            bestValue = value;
            bestMove = move;
        }
    }
    
    // Add randomness for easier difficulties
    if (difficulty === 'easy' && Math.random() < 0.4) {
        return moves[Math.floor(Math.random() * moves.length)];
    } else if (difficulty === 'medium' && Math.random() < 0.15) {
        return moves[Math.floor(Math.random() * moves.length)];
    }
    
    return bestMove || moves[0]; // Fallback to first move
}

// ==================== HELPER TO CHECK GAME OVER ====================
function isGameOver(chessInstance) {
    if (typeof chessInstance.isGameOver === 'function') {
        return chessInstance.isGameOver();
    }
    if (typeof chessInstance.game_over === 'function') {
        return chessInstance.game_over();
    }
    if (typeof chessInstance.gameOver === 'function') {
        return chessInstance.gameOver();
    }
    return chessInstance.moves().length === 0;
}

function checkAndEmitGameOver(chessInstance, roomId = null, socketId = null) {
    if (!isGameOver(chessInstance)) return false;
    
    let winner = null;
    let reason = 'game_over';
    
    if (chessInstance.in_checkmate && chessInstance.in_checkmate()) {
        winner = chessInstance.turn() === 'w' ? 'b' : 'w';
        reason = 'checkmate';
    }
    else if (chessInstance.in_stalemate && chessInstance.in_stalemate()) {
        winner = 'draw';
        reason = 'stalemate';
    }
    else if ((chessInstance.in_threefold_repetition && chessInstance.in_threefold_repetition()) ||
             (chessInstance.insufficient_material && chessInstance.insufficient_material()) ||
             (chessInstance.in_draw && chessInstance.in_draw())) {
        winner = 'draw';
        reason = 'draw';
    }
    
    if (winner) {
        if (roomId) {
            io.to(roomId).emit("gameOver", { winner, reason });
        } else if (socketId) {
            io.to(socketId).emit("gameOver", { winner, reason });
        }
        return true;
    }
    return false;
}

// ==================== LICHESS API BOT ====================
async function makeBotMove(roomId = null, socketId = null) {
    const gameChess = roomId && rooms[roomId] ? rooms[roomId].chess : chess;
    
    if (isGameOver(gameChess)) {
        console.log('Game is over, bot cannot move');
        checkAndEmitGameOver(gameChess, roomId, socketId);
        return;
    }
    
    try {
        const fen = gameChess.fen();
        console.log('🤖 Bot thinking...');
        
        // Try Lichess API with shorter timeout (using native fetch)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const url = 'https://lichess.org/api/cloud-eval?' + new URLSearchParams({ fen: fen, multiPv: '1' }).toString();
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        if (data && data.pvs && data.pvs[0]) {
            const bestMoveUCI = data.pvs[0].moves.split(' ')[0];
            const from = bestMoveUCI.substring(0, 2);
            const to = bestMoveUCI.substring(2, 4);
            const promotion = bestMoveUCI.length > 4 ? bestMoveUCI[4] : undefined;
            
            const move = { from, to };
            if (promotion) move.promotion = promotion;
            
            setTimeout(() => {
                try {
                    if (roomId && rooms[roomId]) {
                        const room = rooms[roomId];
                        const applied = room.chess.move(move);
                        if (applied) {
                            currentPlayer = room.chess.turn();
                            console.log('🤖 Lichess bot played:', move);
                            io.to(roomId).emit("move", move);
                            io.to(roomId).emit("boardState", room.chess.fen());
                            checkAndEmitGameOver(room.chess, roomId, null);
                        } else {
                            makeFallbackBotMove(roomId, socketId);
                        }
                    } else {
                        const applied = chess.move(move);
                        if (applied) {
                            currentPlayer = chess.turn();
                            console.log('🤖 Lichess bot played:', move);
                            if (socketId) {
                                io.to(socketId).emit("move", move);
                                io.to(socketId).emit("boardState", chess.fen());
                            }
                            checkAndEmitGameOver(chess, null, socketId);
                        } else {
                            makeFallbackBotMove(null, socketId);
                        }
                    }
                } catch (e) {
                    console.log('Bot move error:', e.message);
                    makeFallbackBotMove(roomId, socketId);
                }
            }, 500);
        } else {
            console.log('No valid response from Lichess, using smart bot');
            makeFallbackBotMove(roomId, socketId);
        }
    } catch (error) {
        // Silently use fallback bot instead of logging error every time
        if (error.code !== 'ECONNRESET' && error.code !== 'ETIMEDOUT') {
            console.error('Lichess API error:', error.message);
        }
        makeFallbackBotMove(roomId, socketId);
    }
}

function makeFallbackBotMove(roomId = null, socketId = null) {
    const gameChess = roomId && rooms[roomId] ? rooms[roomId].chess : chess;
    
    console.log(`🎯 Using ${botDifficulty.toUpperCase()} smart bot AI`);
    
    const bestMove = getBestMove(gameChess, botDifficulty);
    
    if (bestMove) {
        console.log(`✅ ${botDifficulty.toUpperCase()} bot chose: ${bestMove.san}`);
        
        // FASTER THINKING TIMES
        const thinkingTimes = {
            easy: 300,    // 0.3s (was 600ms)
            medium: 500,  // 0.5s (was 800ms)
            hard: 700,    // 0.7s (was 1000ms)
            expert: 900   // 0.9s (was 1200ms)
        };
        
        executeMove(bestMove, roomId, socketId, thinkingTimes[botDifficulty] || 500);
    }
}

function executeMove(botChoice, roomId, socketId, delay) {
    const move = {
        from: botChoice.from,
        to: botChoice.to,
        // BOT PROMOTES TO QUEEN (best choice for bot)
        promotion: botChoice.promotion || 'q'
    };
    
    setTimeout(() => {
        try {
            if (roomId && rooms[roomId]) {
                const room = rooms[roomId];
                const applied = room.chess.move(move);
                if (applied) {
                    currentPlayer = room.chess.turn();
                    console.log('🤖 Bot played:', move);
                    io.to(roomId).emit("move", move);
                    io.to(roomId).emit("boardState", room.chess.fen());
                    checkAndEmitGameOver(room.chess, roomId, null);
                }
            } else {
                const applied = chess.move(move);
                if (applied) {
                    currentPlayer = chess.turn();
                    console.log('🤖 Bot played:', move);
                    if (socketId) {
                        io.to(socketId).emit("move", move);
                        io.to(socketId).emit("boardState", chess.fen());
                    }
                    checkAndEmitGameOver(chess, null, socketId);
                }
            }
        } catch (e) {
            console.log('Bot move error:', e.message);
        }
    }, delay);
}

app.set("view engine", "ejs");
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true}));

app.get("/", (req, res) => {
    res.render("login", { baseUrl: BASE_URL });
});

app.post("/start", (req, res) => {
    console.log("Form Data:", req.body);
    const { username, mode, botDifficulty: difficulty } = req.body;

    if (mode === "friends" || mode === "online") {
        const gameId = uuidv4();
        return res.redirect(`/game/${gameId}?username=${encodeURIComponent(username)}&mode=friends`);
    }

    if (typeof chess.reset === 'function') {
        chess.reset();
    } else {
        chess = new Chess();
    }
    players = {};
    currentPlayer = 'w';
    botMode = false;
    selfMode = false;
    botDifficulty = difficulty || 'medium'; // Store difficulty
    Object.keys(disconnectTimers).forEach((k) => { clearInterval(disconnectTimers[k]); });
    disconnectTimers = {};

return res.render("index", { username, mode, botDifficulty: difficulty || 'medium', baseUrl: BASE_URL });
});

app.get("/game/:gameId", (req, res) => {
    const { username, mode } = req.query;
    const { gameId } = req.params;
res.render("index", { username, mode, gameId, botDifficulty: 'medium', baseUrl: BASE_URL });
});

function sendPlayersUpdate() {
  io.emit("playersUpdate", {
    white: players.whiteName || null,
    black: players.blackName || null,
  });
}

io.on("connection", function(uniquesocket){
    console.log("connected:", uniquesocket.id);

    function sendPlayersUpdateRoom(roomId){
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit("playersUpdate", {
            white: room.players.whiteName || null,
            black: room.players.blackName || null,
        });
    }

    uniquesocket.on("joinRoom", ({ gameId }) => {
        console.log("=== JOIN ROOM DEBUG ===");
        console.log("Socket ID:", uniquesocket.id);
        console.log("Game ID:", gameId);
        
        if (!gameId) return;
        if (!uniquesocket.username || uniquesocket.username.trim() === '') {
            console.log("❌ Username validation failed");
            uniquesocket.emit("error", "Please set your username before joining the room.");
            return;
        }
        
        // Clear any global disconnect timers when joining a room
        Object.keys(disconnectTimers).forEach((role) => {
            if (disconnectTimers[role]) {
                clearInterval(disconnectTimers[role]);
                delete disconnectTimers[role];
                console.log(`🧹 Cleared global disconnect timer for ${role}`);
            }
        });
        
        uniquesocket.roomId = gameId;
        if (!rooms[gameId]) {
            console.log("🆕 Creating new room:", gameId);
            rooms[gameId] = {
                chess: new Chess(),
                players: {},
                disconnectTimers: {},
                rematchRequests: new Set()
            };
        }
        
        const room = rooms[gameId];
        uniquesocket.join(gameId);

        const whiteAvailable = !room.players.whiteId || !io.sockets.sockets.has(room.players.whiteId);
        
        if (whiteAvailable) {
            console.log("✅ Assigning as WHITE player");
            room.players.whiteId = uniquesocket.id;
            room.players.whiteName = uniquesocket.username;
            uniquesocket.role = "w";
        } 
        else {
            const blackAvailable = !room.players.blackId || !io.sockets.sockets.has(room.players.blackId);
            
            if (blackAvailable && room.players.whiteId !== uniquesocket.id) {
                console.log("✅ Assigning as BLACK player");
                room.players.blackId = uniquesocket.id;
                room.players.blackName = uniquesocket.username;
                uniquesocket.role = "b";
            } else {
                console.log("⚠️ No slots available");
                uniquesocket.emit("spectatorRole");
                uniquesocket.emit("boardState", room.chess.fen());
                return;
            }
        }

        // Clear any existing disconnect timer for this player's role
        if (uniquesocket.role && room.disconnectTimers[uniquesocket.role]) {
            clearInterval(room.disconnectTimers[uniquesocket.role]);
            delete room.disconnectTimers[uniquesocket.role];
            io.to(gameId).emit("opponentDisconnectCountdown", { opponent: uniquesocket.role, seconds: 0 });
            console.log(`✅ Cleared disconnect timer for ${uniquesocket.role} in ${gameId}`);
        }

        sendPlayersUpdateRoom(gameId);

        const bothPlayersReady = room.players.whiteId && room.players.blackId && 
                                room.players.whiteName && room.players.blackName;
        
        if (bothPlayersReady) {
            console.log("🎮 Starting game!");
            io.to(room.players.whiteId).emit("playerRole", "w");
            io.to(room.players.blackId).emit("playerRole", "b");
            io.to(gameId).emit("boardState", room.chess.fen());
            io.to(gameId).emit("startGame");
            io.to(gameId).emit("hideLink");
            sendPlayersUpdateRoom(gameId);
        } else {
            console.log("⏳ Waiting for second player");
            uniquesocket.emit("waiting", "waiting for another player to join...");
        }
        
        console.log("=== END JOIN ROOM DEBUG ===\n");
    });

    uniquesocket.on("setUsername", (username) => {
        if (!username || username.trim() === '') {
            uniquesocket.emit("error", "Username cannot be empty.");
            return;
        }
        
        uniquesocket.username = username.trim();
        
        const roomId = uniquesocket.roomId;
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            if (uniquesocket.id === room.players.whiteId) room.players.whiteName = uniquesocket.username;
            if (uniquesocket.id === room.players.blackId) room.players.blackName = uniquesocket.username;

            sendPlayersUpdateRoom(roomId);

            if (room.players.whiteName && room.players.blackName) {
                io.to(room.players.whiteId).emit("playerRole", "w");
                io.to(room.players.blackId).emit("playerRole", "b");
                io.to(roomId).emit("boardState", room.chess.fen());
                io.to(roomId).emit("startGame");
                io.to(roomId).emit("hideLink");
            }
        } else {
            if (uniquesocket.id === players.white) players.whiteName = uniquesocket.username;
            if (uniquesocket.id === players.black) players.blackName = uniquesocket.username;
            sendPlayersUpdate();
        }
    });

    uniquesocket.on("disconnect", function(){
        console.log('=== DISCONNECT DEBUG ===');
        console.log('Socket disconnected:', uniquesocket.id);
        
        if (uniquesocket.roomId && rooms[uniquesocket.roomId]) {
            const roomId = uniquesocket.roomId;
            const room = rooms[roomId];
            let role = null;
            
            if (uniquesocket.id === room.players.whiteId) {
                role = "w";
            } else if (uniquesocket.id === room.players.blackId) {
                role = "b";
            }
            
            if (role) {
                const opponentRole = role === "w" ? "b" : "w";
                const opponentId = opponentRole === 'w' ? room.players.whiteId : room.players.blackId;
                
                // Check if opponent socket exists and is connected
                const opponentSocket = opponentId ? io.sockets.sockets.get(opponentId) : null;
                const opponentConnected = opponentSocket && opponentSocket.connected;
                
                const bothPlayersWereAssigned = room.players.whiteId && room.players.blackId;
                
                console.log('Opponent connected?', opponentConnected);
                console.log('Both players were assigned?', bothPlayersWereAssigned);
                
                if (bothPlayersWereAssigned && opponentConnected) {
                    let remaining = 60;
                    io.to(roomId).emit("opponentDisconnectCountdown", { opponent: role, seconds: remaining });
                    room.disconnectTimers[role] = setInterval(() => {
                        remaining -= 1;
                        if (remaining > 0) {
                            io.to(roomId).emit("opponentDisconnectCountdown", { opponent: role, seconds: remaining });
                        } else {
                            clearInterval(room.disconnectTimers[role]);
                            delete room.disconnectTimers[role];
                            io.to(roomId).emit("gameOver", { winner: opponentRole, reason: "opponent_disconnected" });
                        }
                    }, 1000);
                    console.log(`✅ ${role} disconnected. Starting 60s countdown.`);
                } else {
                    console.log(`❌ ${role} disconnected but no countdown needed.`);
                }
                
                delete room.players[role === 'w' ? 'whiteId' : 'blackId'];
                delete room.players[role === 'w' ? 'whiteName' : 'blackName'];
            }
            
            sendPlayersUpdateRoom(roomId);
            return;
        }
        
        let role = null;
        if(uniquesocket.id === players.white){
            role = "w";
            delete players.white;
            delete players.whiteName;
        }
        else if(uniquesocket.id === players.black){
            role = "b";
            delete players.black;
            delete players.blackName;
        }
        sendPlayersUpdate();
        
        if (role && !botMode && !selfMode) {
            const opponentRole = role === "w" ? "b" : "w";
            const opponentId = opponentRole === 'w' ? players.white : players.black;
            
            if (!opponentId) {
                console.log(`${role} disconnected, no opponent present.`);
                return;
            }
            
            let remaining = 60;
            io.emit("opponentDisconnectCountdown", { opponent: role, seconds: remaining });
            disconnectTimers[role] = setInterval(() => {
                remaining -= 1;
                if (remaining > 0) {
                    io.emit("opponentDisconnectCountdown", { opponent: role, seconds: remaining });
                } else {
                    clearInterval(disconnectTimers[role]);
                    delete disconnectTimers[role];
                    io.emit("gameOver", { winner: opponentRole, reason: "opponent_disconnected" });
                }
            }, 1000);
        }
    });

    uniquesocket.on("reconnectPlayer", (role) => {
        if (uniquesocket.roomId && rooms[uniquesocket.roomId]) {
            const roomId = uniquesocket.roomId;
            const room = rooms[roomId];
            if (room.disconnectTimers[role]) {
                clearInterval(room.disconnectTimers[role]);
                delete room.disconnectTimers[role];
                io.to(roomId).emit("opponentDisconnectCountdown", { opponent: role, seconds: 0 });
            }
            if (role === "w" && !room.players.whiteId) room.players.whiteId = uniquesocket.id;
            if (role === "b" && !room.players.blackId) room.players.blackId = uniquesocket.id;
            uniquesocket.emit("boardState", room.chess.fen());
            sendPlayersUpdateRoom(roomId);
            return;
        }
        if (disconnectTimers[role]) {
            clearInterval(disconnectTimers[role]);
            delete disconnectTimers[role];
            io.emit("opponentDisconnectCountdown", { opponent: role, seconds: 0 });
        }

        if (role === "w" && !players.white) players.white = uniquesocket.id;
        if (role === "b" && !players.black) players.black = uniquesocket.id;

        uniquesocket.emit("boardState", chess.fen());
        sendPlayersUpdate(); 
    });

    uniquesocket.on("setMode", (mode) => {
        console.log('=== SET MODE ===');
        console.log('Socket:', uniquesocket.id);
        console.log('Previous roomId:', uniquesocket.roomId);
        console.log('New mode:', mode);
        
        // CRITICAL: Leave any room the socket is currently in
        if (uniquesocket.roomId && rooms[uniquesocket.roomId]) {
            const oldRoomId = uniquesocket.roomId;
            const oldRoom = rooms[oldRoomId];
            
            console.log(`🚪 Socket leaving room ${oldRoomId}`);
            
            // Remove player from old room
            if (uniquesocket.id === oldRoom.players.whiteId) {
                delete oldRoom.players.whiteId;
                delete oldRoom.players.whiteName;
                console.log('Removed as white from old room');
            }
            if (uniquesocket.id === oldRoom.players.blackId) {
                delete oldRoom.players.blackId;
                delete oldRoom.players.blackName;
                console.log('Removed as black from old room');
            }
            
            // Clear any disconnect timers for this room
            Object.keys(oldRoom.disconnectTimers).forEach(role => {
                if (oldRoom.disconnectTimers[role]) {
                    clearInterval(oldRoom.disconnectTimers[role]);
                    delete oldRoom.disconnectTimers[role];
                }
            });
            
            // Leave the socket.io room
            uniquesocket.leave(oldRoomId);
            
            // Notify remaining player
            sendPlayersUpdateRoom(oldRoomId);
            
            // Clear room reference
            delete uniquesocket.roomId;
            delete uniquesocket.role;
        }
        
        // Clear all global disconnect timers
        Object.keys(disconnectTimers).forEach((role) => {
            if (disconnectTimers[role]) {
                clearInterval(disconnectTimers[role]);
                delete disconnectTimers[role];
                console.log(`Cleared global disconnect timer for ${role}`);
            }
        });
        
        // Clear disconnect countdown display for everyone
        io.emit("opponentDisconnectCountdown", { opponent: 'w', seconds: 0 });
        io.emit("opponentDisconnectCountdown", { opponent: 'b', seconds: 0 });
        
        if (typeof chess.reset === 'function') chess.reset();
        else chess = new Chess();

        botMode = false;
        selfMode = false;

        if (mode === 'bot') botMode = true;
        else if (mode === 'self') selfMode = true;

        lastPlayerWasWhite = !lastPlayerWasWhite;

        if (lastPlayerWasWhite) {
            players.white = uniquesocket.id;
            players.whiteName = uniquesocket.username || 'You';
        
            if (mode === 'bot') {
                players.black = 'BOT';
                players.blackName = 'Bot';
            } else if (mode === 'self') {
                players.black = uniquesocket.id;
                players.blackName = players.whiteName;
            } else {
                players.black = null;
                players.blackName = null;
            }

            io.to(players.white).emit("playerRole", "w");
        } else {
            players.black = uniquesocket.id;
            players.blackName = uniquesocket.username || 'You';
        
            if (mode === 'bot') {
                players.white = 'BOT';
                players.whiteName = 'Bot';
            } else if (mode === 'self') {
                players.white = uniquesocket.id;
                players.whiteName = players.blackName;
            } else {
                players.white = null;
                players.whiteName = null;
            }

            io.to(players.black).emit("playerRole", "b");
        }
        
        // Only emit to this specific socket, not to rooms
        uniquesocket.emit("boardState", chess.fen());
        uniquesocket.emit("startGame");
        uniquesocket.emit("hideLink");
        sendPlayersUpdate();

        if (botMode && players.white === 'BOT' && chess.turn() === 'w') {
            setTimeout(() => makeBotMove(null, uniquesocket.id), 1000);
        }
        
        console.log('=== END SET MODE ===');
    });

    uniquesocket.on("move", (move)=>{
        try{
            // Roomed move - ONLY emit to room
            if (uniquesocket.roomId && rooms[uniquesocket.roomId]) {
                const roomId = uniquesocket.roomId;
                const room = rooms[roomId];
                const rchess = room.chess;
                if (rchess.turn() === 'w' && uniquesocket.id !== room.players.whiteId) return;
                if (rchess.turn() === 'b' && uniquesocket.id !== room.players.blackId) return;
                const result = rchess.move(move);
                if (result) {
                    currentPlayer = rchess.turn();
                    io.to(roomId).emit("move", move);
                    io.to(roomId).emit("boardState", rchess.fen());
                    checkAndEmitGameOver(rchess, roomId);
                } else {
                    uniquesocket.emit("InvalidMove", move);
                }
                return;
            }

            // Global game move - ONLY for bot/self, emit only to this socket
            if(chess.turn() === 'w' && uniquesocket.id !== players.white) return;
            if(chess.turn() === 'b' && players.black !== 'BOT' && uniquesocket.id !== players.black) return;

            const result = chess.move(move);

            if(result){
                currentPlayer = chess.turn();
                // CRITICAL FIX: Only emit to this socket, not broadcast
                uniquesocket.emit("move", move);
                uniquesocket.emit("boardState", chess.fen());
                
                const gameEnded = checkAndEmitGameOver(chess, null, uniquesocket.id);

                if (botMode && !gameEnded && !isGameOver(chess)) {
                    if (players.black === 'BOT' && chess.turn() === 'b') {
                        setTimeout(() => makeBotMove(null, uniquesocket.id), 500);
                    } else if (players.white === 'BOT' && chess.turn() === 'w') {
                        setTimeout(() => makeBotMove(null, uniquesocket.id), 500);
                    }
                }
            } else {
                uniquesocket.emit("InvalidMove", move);
            }
        } catch(error) {
            console.error('Move error:', error);
            uniquesocket.emit("InvalidMove", move);
        }
    });

    uniquesocket.on("resign", (data) => {
        console.log('=== RESIGN DEBUG ===');
        console.log('Socket:', uniquesocket.id);
        console.log('Room ID:', uniquesocket.roomId);
        console.log('Data:', data);
        
        // Room-based resign - ONLY affect this room
        if (uniquesocket.roomId && rooms[uniquesocket.roomId]) {
            const roomId = uniquesocket.roomId;
            const room = rooms[roomId];
            let role = null;
            if (uniquesocket.id === room.players.whiteId) role = 'w';
            else if (uniquesocket.id === room.players.blackId) role = 'b';
            if (!role) {
                console.log('Socket not a player in this room');
                return;
            }
            const winner = role === 'w' ? 'b' : 'w';
            console.log(`Room resign: ${role} resigned, ${winner} wins - only in room ${roomId}`);
            io.to(roomId).emit("gameOver", { winner, reason: 'resign' });
            return;
        }
        
        // Global resign (bot/self mode)
        let resigningRole = null;
        
        if (selfMode && data && data.resigningAs) {
            resigningRole = data.resigningAs;
        } else if (selfMode) {
            resigningRole = chess.turn();
        } else {
            if (uniquesocket.id === players.white) resigningRole = 'w';
            else if (uniquesocket.id === players.black) resigningRole = 'b';
        }
        
        if (!resigningRole) {
            console.log('No resigning role found');
            return;
        }
        
        const winner = resigningRole === 'w' ? 'b' : 'w';
        console.log(`Global resign: ${resigningRole} resigned, ${winner} wins`);
        // Only emit to this socket, not broadcast
        uniquesocket.emit("gameOver", { winner, reason: 'resign' });
    });

    uniquesocket.on("resetGame", () => {
        if (uniquesocket.roomId && rooms[uniquesocket.roomId]) {
            const roomId = uniquesocket.roomId;
            const room = rooms[roomId];

            // Ensure rematchRequests set exists
            if (!room.rematchRequests) room.rematchRequests = new Set();
            room.rematchRequests.add(uniquesocket.id);

            // Wait for both players to click Play Again to avoid double-flip
            const whiteId = room.players.whiteId;
            const blackId = room.players.blackId;
            if (!whiteId || !blackId) {
                // If both players not present, just reset without flipping
                room.chess = new Chess();
                io.to(roomId).emit("boardState", room.chess.fen());
                io.to(roomId).emit("startGame");
                sendPlayersUpdateRoom(roomId);
                return;
            }

            if (room.rematchRequests.size < 2) {
                // Notify waiting state (optional)
                io.to(roomId).emit("waiting", "Waiting for opponent to accept rematch...");
                return;
            }

            // Both confirmed: clear requests and flip colors once
            room.rematchRequests.clear();

            // Swap player assignments
            const prevWhiteId = room.players.whiteId;
            const prevWhiteName = room.players.whiteName;
            room.players.whiteId = room.players.blackId;
            room.players.whiteName = room.players.blackName;
            room.players.blackId = prevWhiteId;
            room.players.blackName = prevWhiteName;

            // Reset board
            room.chess = new Chess();

            // Tell each socket their new role
            if (room.players.whiteId) io.to(room.players.whiteId).emit("playerRole", "w");
            if (room.players.blackId) io.to(room.players.blackId).emit("playerRole", "b");

            // Start game for room
            io.to(roomId).emit("boardState", room.chess.fen());
            io.to(roomId).emit("startGame");
            io.to(roomId).emit("hideLink");
            sendPlayersUpdateRoom(roomId);
            return;
        }   

        chess.reset ? chess.reset() : (chess = new Chess());
        lastPlayerWasWhite = !lastPlayerWasWhite;
        players = {};

        if (lastPlayerWasWhite) {
            players.white = uniquesocket.id;
            players.whiteName = uniquesocket.username || 'You';
            if (botMode) {
                players.black = 'BOT';
                players.blackName = 'Bot';
            } else if (selfMode) {
                players.black = uniquesocket.id;
                players.blackName = players.whiteName;
            }
            io.to(players.white).emit("playerRole", "w");
        } else {
            players.black = uniquesocket.id;
            players.blackName = uniquesocket.username || 'You';
            if (botMode) {
                players.white = 'BOT';
                players.whiteName = 'Bot';
            } else if (selfMode) {
                players.white = uniquesocket.id;
                players.whiteName = players.blackName;
            }
            io.to(players.black).emit("playerRole", "b");
        }

        io.emit("boardState", chess.fen());
        io.emit("startGame");
        io.emit("hideLink");
        sendPlayersUpdate();

        if (botMode && players.white === 'BOT' && chess.turn() === 'w') {
            setTimeout(() => makeBotMove(null, uniquesocket.id), 1000);
        }
    });
});

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;
let triedRandom = false;

function openBrowser(url) {
    try {
        if (process.platform === 'win32') exec(`start "" "${url}"`);
        else if (process.platform === 'darwin') exec(`open "${url}"`);
        else exec(`xdg-open "${url}"`);
    } catch {}
}

function startServer(port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            if (err && err.code === 'EADDRINUSE' && !triedRandom) {
                console.warn(`⚠️ Port ${port} in use, retrying on a random port...`);
                triedRandom = true;
                // Try again on random port; resolve when inner succeeds
                startServer(0).then(resolve).catch(reject);
            } else {
                console.error('Server failed to start:', err);
                // Prevent instant window close on error when double-clicking the .exe
                setTimeout(() => {}, 10000);
                reject(err);
            }
        };

        const host = process.env.HOST || '0.0.0.0';
        server.listen(port, host, function () {
            const actualPort = server.address().port;
            const localUrl = `http://localhost:${actualPort}/`;
            const lanIp = getLanAddress();
            BASE_URL = `http://${lanIp}:${actualPort}`;
            console.log(`✅ Server running:`);
            console.log(`   Local:   ${localUrl}`);
            console.log(`   Network: ${BASE_URL}`);
            console.log(`🤖 Using Smart AI Bot with Minimax Algorithm`);
            console.log(`🎯 Bot difficulty levels: Easy, Medium, Hard, Expert`);
            if (process.env.AUTO_OPEN !== 'false') openBrowser(localUrl);
            resolve({ port: actualPort, url: localUrl, lanUrl: BASE_URL });
        }).on('error', onError);
    });
}

if (require.main === module) {
    startServer(DEFAULT_PORT).catch(() => process.exit(1));
}

module.exports = { startServer };
