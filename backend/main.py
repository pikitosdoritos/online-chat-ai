import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal, get_db, init_db
from .models import Message


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
UPLOADS_DIR = BASE_DIR / "uploads"
MAX_MESSAGE_LENGTH = 1000
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

ALLOWED_EXTENSIONS: dict[str, set[str]] = {
    "image": {".jpg", ".jpeg", ".png"},
    "video": {".mp4"},
    "audio": {".mp3", ".wav"},
    "file": {".pdf", ".txt", ".doc", ".docx", ".zip"},
}
ALL_ALLOWED_EXTENSIONS = set().union(*ALLOWED_EXTENSIONS.values())

app = FastAPI(title="Online Chat AI", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: dict[WebSocket, str] = {}

    async def connect(self, websocket: WebSocket, username: str) -> None:
        await websocket.accept()
        self.active_connections[websocket] = username

    def disconnect(self, websocket: WebSocket) -> str | None:
        return self.active_connections.pop(websocket, None)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        stale_connections: list[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_json(payload)
            except Exception:
                stale_connections.append(connection)
        for stale in stale_connections:
            self.disconnect(stale)

    @property
    def connected_count(self) -> int:
        return len(self.active_connections)

    def get_participants(self) -> list[str]:
        return sorted(set(self.active_connections.values()), key=str.lower)


manager = ConnectionManager()


def now_utc() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def serialize_message(message: Message) -> dict[str, Any]:
    return {
        "id": message.id,
        "username": message.username,
        "content": message.content,
        "message_type": message.message_type,
        "file_path": message.file_path,
        "original_file_name": message.original_file_name,
        "edited": bool(message.edited),
        "deleted": bool(message.deleted),
        "created_at": message.created_at.isoformat() if message.created_at else None,
        "updated_at": message.updated_at.isoformat() if message.updated_at else None,
        "user_color": get_user_color(message.username),
    }


def get_user_color(username: str) -> str:
    palette = [
        "#60A5FA",
        "#34D399",
        "#F472B6",
        "#FBBF24",
        "#A78BFA",
        "#22D3EE",
        "#FB7185",
        "#4ADE80",
        "#F97316",
        "#818CF8",
    ]
    if not username:
        return palette[0]
    total = 0
    for idx, char in enumerate(username):
        total += (idx + 1) * ord(char)
    return palette[total % len(palette)]


def normalize_message_type(message_type: str) -> str:
    normalized = (message_type or "text").strip().lower()
    if normalized not in {"text", "image", "video", "audio", "file"}:
        raise ValueError("Invalid message type.")
    return normalized


def detect_file_type(extension: str) -> str:
    for message_type, extensions in ALLOWED_EXTENSIONS.items():
        if extension in extensions:
            return message_type
    raise ValueError("Unsupported file type.")


@app.on_event("startup")
def on_startup() -> None:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    init_db()


@app.get("/api/messages")
def get_messages(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    statement = select(Message).order_by(Message.created_at.desc(), Message.id.desc()).limit(limit)
    rows = db.execute(statement).scalars().all()
    rows.reverse()
    return [serialize_message(message) for message in rows]


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    original_name = (file.filename or "").strip()
    if not original_name:
        raise HTTPException(status_code=400, detail="Missing file name.")

    extension = Path(original_name).suffix.lower()
    if extension not in ALL_ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="File type is not allowed.")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="File is empty.")
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10MB).")

    safe_name = f"{uuid4().hex}{extension}"
    disk_path = UPLOADS_DIR / safe_name
    disk_path.write_bytes(content)

    return {
        "file_path": f"/uploads/{safe_name}",
        "message_type": detect_file_type(extension),
        "original_file_name": Path(original_name).name,
        "size_bytes": len(content),
    }


@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    username = (websocket.query_params.get("username") or "").strip()
    if not username:
        await websocket.close(code=1008, reason="username_required")
        return
    if len(username) > 24:
        await websocket.close(code=1008, reason="username_too_long")
        return

    await manager.connect(websocket, username)
    participants = manager.get_participants()
    await websocket.send_json(
        {
            "type": "participants_update",
            "participants": [
                {"username": participant, "color": get_user_color(participant)} for participant in participants
            ],
        }
    )
    await manager.broadcast(
        {
            "type": "presence",
            "event": "join",
            "username": username,
            "user_color": get_user_color(username),
            "timestamp": datetime.utcnow().isoformat(),
            "connected_count": manager.connected_count,
        }
    )
    await manager.broadcast(
        {
            "type": "participants_update",
            "participants": [
                {"username": participant, "color": get_user_color(participant)}
                for participant in manager.get_participants()
            ],
        }
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Invalid message format.",
                    }
                )
                continue

            action = (payload.get("action") or "").strip().lower()
            if action not in {"send", "edit", "delete"}:
                await websocket.send_json({"type": "error", "message": "Unsupported action."})
                continue

            if action == "send":
                content = (payload.get("content") or "").strip()
                message_type = normalize_message_type(payload.get("message_type", "text"))
                file_path = payload.get("file_path")
                original_file_name = payload.get("original_file_name")

                if message_type == "text":
                    if not content:
                        continue
                    if len(content) > MAX_MESSAGE_LENGTH:
                        await websocket.send_json(
                            {"type": "error", "message": "Message is too long (max 1000 characters)."}
                        )
                        continue
                    file_path = None
                    original_file_name = None
                else:
                    if not isinstance(file_path, str) or not file_path.startswith("/uploads/"):
                        await websocket.send_json({"type": "error", "message": "Invalid uploaded file path."})
                        continue
                    candidate = (BASE_DIR / file_path.lstrip("/")).resolve()
                    if not candidate.exists() or UPLOADS_DIR.resolve() not in candidate.parents:
                        await websocket.send_json({"type": "error", "message": "Uploaded file not found."})
                        continue
                    if not content:
                        content = original_file_name or "Shared a file"
                    if len(content) > MAX_MESSAGE_LENGTH:
                        content = content[:MAX_MESSAGE_LENGTH]

                with SessionLocal() as db:
                    message = Message(
                        username=username,
                        content=content,
                        message_type=message_type,
                        file_path=file_path,
                        original_file_name=original_file_name,
                        edited=False,
                        deleted=False,
                    )
                    db.add(message)
                    db.commit()
                    db.refresh(message)

                await manager.broadcast({"type": "message_created", "message": serialize_message(message)})
                continue

            message_id = payload.get("id")
            if not isinstance(message_id, int):
                await websocket.send_json({"type": "error", "message": "Invalid message id."})
                continue

            with SessionLocal() as db:
                message = db.get(Message, message_id)
                if not message:
                    await websocket.send_json({"type": "error", "message": "Message not found."})
                    continue
                if message.username != username:
                    await websocket.send_json({"type": "error", "message": "You can only change your own messages."})
                    continue
                if message.deleted:
                    await websocket.send_json({"type": "error", "message": "Message already deleted."})
                    continue

                if action == "edit":
                    if message.message_type != "text":
                        await websocket.send_json({"type": "error", "message": "Only text messages can be edited."})
                        continue
                    new_content = (payload.get("content") or "").strip()
                    if not new_content:
                        await websocket.send_json({"type": "error", "message": "Edited message cannot be empty."})
                        continue
                    if len(new_content) > MAX_MESSAGE_LENGTH:
                        await websocket.send_json(
                            {"type": "error", "message": "Message is too long (max 1000 characters)."}
                        )
                        continue
                    message.content = new_content
                    message.edited = True
                    message.updated_at = now_utc()
                    db.commit()
                    db.refresh(message)
                    await manager.broadcast({"type": "message_updated", "message": serialize_message(message)})
                    continue

                if action == "delete":
                    message.content = "Message deleted"
                    message.file_path = None
                    message.original_file_name = None
                    message.deleted = True
                    message.edited = False
                    message.updated_at = now_utc()
                    db.commit()
                    db.refresh(message)
                    await manager.broadcast({"type": "message_deleted", "message": serialize_message(message)})
    except WebSocketDisconnect:
        disconnected_user = manager.disconnect(websocket)
        if disconnected_user:
            await manager.broadcast(
                {
                    "type": "presence",
                    "event": "leave",
                    "username": disconnected_user,
                    "user_color": get_user_color(disconnected_user),
                    "timestamp": datetime.utcnow().isoformat(),
                    "connected_count": manager.connected_count,
                }
            )
            await manager.broadcast(
                {
                    "type": "participants_update",
                    "participants": [
                        {"username": participant, "color": get_user_color(participant)}
                        for participant in manager.get_participants()
                    ],
                }
            )
    except Exception:
        manager.disconnect(websocket)
        await websocket.close(code=1011)


@app.delete("/api/messages")
def clear_all_messages(db: Session = Depends(get_db)):
    """Clear all messages from the chat"""
    try:
        # Delete all messages
        db.query(Message).delete()
        db.commit()
        
        # Clear uploaded files
        for file_path in UPLOADS_DIR.glob("*"):
            if file_path.is_file():
                file_path.unlink()
        
        return {"message": "All messages and files cleared successfully"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to clear messages: {str(e)}")


@app.get("/", response_class=FileResponse)
def serve_index():
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend not found.")
    return FileResponse(index_path)


app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
