from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker


BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "chat.db"
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    future=True,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _run_lightweight_migrations()


def _run_lightweight_migrations() -> None:
    with engine.begin() as conn:
        columns = {
            row[1]
            for row in conn.execute(text("PRAGMA table_info(messages)")).fetchall()
        }
        if "message_type" not in columns:
            conn.execute(
                text("ALTER TABLE messages ADD COLUMN message_type VARCHAR(20) NOT NULL DEFAULT 'text'")
            )
        if "file_path" not in columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN file_path VARCHAR(255)"))
        if "original_file_name" not in columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN original_file_name VARCHAR(255)"))
        if "edited" not in columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN edited BOOLEAN NOT NULL DEFAULT 0"))
        if "deleted" not in columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT 0"))
        if "updated_at" not in columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN updated_at DATETIME"))
