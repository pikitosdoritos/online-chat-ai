from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal, get_db, init_db
from .models import Message


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

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


manager = ConnectionManager()


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/api/messages")
def get_messages(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    statement = select(Message).order_by(Message.created_at.desc(), Message.id.desc()).limit(limit)
    rows = db.execute(statement).scalars().all()
    rows.reverse()
    return [
        {
            "id": message.id,
            "username": message.username,
            "content": message.content,
            "created_at": message.created_at.isoformat(),
        }
        for message in rows
    ]


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
    await manager.broadcast(
        {
            "type": "presence",
            "event": "join",
            "username": username,
            "timestamp": datetime.utcnow().isoformat(),
            "connected_count": manager.connected_count,
        }
    )

    try:
        while True:
            text = (await websocket.receive_text()).strip()
            if not text:
                continue
            if len(text) > 1000:
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Message is too long (max 1000 characters).",
                    }
                )
                continue

            with SessionLocal() as db:
                message = Message(username=username, content=text)
                db.add(message)
                db.commit()
                db.refresh(message)

            await manager.broadcast(
                {
                    "type": "message",
                    "id": message.id,
                    "username": message.username,
                    "content": message.content,
                    "created_at": message.created_at.isoformat(),
                }
            )
    except WebSocketDisconnect:
        disconnected_user = manager.disconnect(websocket)
        if disconnected_user:
            await manager.broadcast(
                {
                    "type": "presence",
                    "event": "leave",
                    "username": disconnected_user,
                    "timestamp": datetime.utcnow().isoformat(),
                    "connected_count": manager.connected_count,
                }
            )
    except Exception:
        manager.disconnect(websocket)
        await websocket.close(code=1011)


@app.get("/", response_class=FileResponse)
def serve_index():
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend not found.")
    return FileResponse(index_path)


app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")
