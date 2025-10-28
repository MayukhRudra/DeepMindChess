import socketio
import chess
import random

sio = socketio.Client()
chessboard = chess.Board()
player_role = None


def connect():
    print("✅ Connected to server!")


def connect_error(data):
    print("❌ Connection failed:", data)


def disconnect():
    print("🔌 Disconnected from server")


def on_player_role(role):
    global player_role
    player_role = role
    print("I am playing as", "White" if role == "w" else "Black")


def on_spectator():
    print("I am a spectator")


def on_boardstate(fen):
    global player_role
    chessboard.set_fen(fen)
    print("Board updated:", fen)

    turn="w" if chessboard.turn else "b"
    if turn == player_role:
        make_moves()


def on_move(move):
    try:
        chessboard.push(chess.Move.from_uci(move["from"] + move["to"]))
        print("Opponent moved:", move)
    except Exception as e:
        print("Invalid move received:", move, e)

print("🔍 Trying to connect to server...")
sio.connect("http://localhost:3000")
print("➡️ Python reached after connect() call")

def make_moves():
    if chessboard.is_game_over():
        print("Game Over")
        return
    
    move=random.choice(list(chessboard.legal_moves))
    chessboard.push(move)
    sio.emit("move", {
        "from": move.uci()[:2],
        "to": move.uci()[2:4],
        "promotion": "q"
    })
    print("Bot played:", move.uci())
    
sio.wait()  

