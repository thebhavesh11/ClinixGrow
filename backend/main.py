"""SmartFlow AI Automation Platform — FastAPI Backend."""

import os
import logging
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

load_dotenv()

# ── Structured Logging ────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("smartflow")

from database import engine, Base
from routers import business, ai_settings, leads, conversations, dashboard, whatsapp, media, appointments, voice, clients, demo_chat, portal


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create tables on startup, migrate columns, and seed defaults."""
    from database import async_session
    from sqlalchemy import select, text
    import secrets
    from models import Business, AISetting, WorkingHours, VoiceSettings

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # Ensure portal columns exist in SQLite
            try:
                res = await conn.execute(text("PRAGMA table_info(businesses)"))
                cols = [row[1] for row in res.fetchall()]
                if "portal_token" not in cols:
                    await conn.execute(text("ALTER TABLE businesses ADD COLUMN portal_token VARCHAR(64)"))
                    logger.info("Migrated: added portal_token to businesses")
                if "portal_pin" not in cols:
                    await conn.execute(text("ALTER TABLE businesses ADD COLUMN portal_pin VARCHAR(20)"))
                    logger.info("Migrated: added portal_pin to businesses")
                if "logo_url" not in cols:
                    await conn.execute(text("ALTER TABLE businesses ADD COLUMN logo_url VARCHAR(500) DEFAULT ''"))
                    logger.info("Migrated: added logo_url to businesses")
            except Exception as mig_err:
                logger.warning(f"Column migration check warning: {mig_err}")

        logger.info("Database tables created/verified")

        # Seed default business & AI settings if not exists
        async with async_session() as session:
            async with session.begin():
                result = await session.execute(select(Business).where(Business.id == 1))
                biz1 = result.scalar_one_or_none()
                if not biz1:
                    session.add(Business(name="My Business", portal_token=f"portal_{secrets.token_urlsafe(16)}"))
                    await session.flush()
                    logger.info("Seeded default business profile")

                # Ensure all businesses have a portal_token
                all_bizs = (await session.execute(select(Business))).scalars().all()
                for b in all_bizs:
                    if not b.portal_token:
                        b.portal_token = f"portal_{secrets.token_urlsafe(16)}"
                        logger.info(f"Generated portal_token for {b.name}: {b.portal_token}")
                result = await session.execute(select(AISetting).where(AISetting.business_id == 1))
                if not result.scalar_one_or_none():
                    session.add(AISetting(business_id=1))
                    logger.info("Seeded default AI settings")

                # Seed default working hours if not exist
                result = await session.execute(select(WorkingHours).where(WorkingHours.business_id == 1))
                if not result.scalars().first():
                    for day in range(7):
                        session.add(WorkingHours(
                            business_id=1,
                            day_of_week=day,
                            is_open=1 if day < 5 else 0,  # Mon-Fri open, Sat-Sun closed
                            start_time="09:00",
                            end_time="18:00",
                            break_start="13:00",
                            break_end="14:00",
                            slot_duration=30,
                        ))
                    logger.info("Seeded default working hours (Mon-Fri 09:00-18:00)")

                # Seed default VoiceSettings if not exist
                result = await session.execute(select(VoiceSettings).where(VoiceSettings.business_id == 1))
                if not result.scalar_one_or_none():
                    import secrets
                    session.add(VoiceSettings(business_id=1, webhook_secret=secrets.token_hex(16)))
                    logger.info("Seeded default voice settings")
    except Exception as e:
        logger.error(f"Startup error: {type(e).__name__}: {e}")
        raise

    # Start background reminder task
    import asyncio
    from automation.reminders import reminder_loop
    reminder_task = asyncio.create_task(reminder_loop())

    yield

    reminder_task.cancel()
    await engine.dispose()
    logger.info("Database connections closed")


app = FastAPI(
    title="SmartFlow AI",
    description="AI-Powered WhatsApp Automation Platform",
    version="1.0.0",
    lifespan=lifespan,
)


# ── Global Exception Handler ─────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch any unhandled exception and return a structured error instead of crashing."""
    logger.error(f"Unhandled error on {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": str(exc)},
    )


# CORS — Allow all origins for Codespaces compatibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(business.router)
app.include_router(ai_settings.router)
app.include_router(leads.router)
app.include_router(conversations.router)
app.include_router(dashboard.router)
app.include_router(whatsapp.router)
app.include_router(media.router)
app.include_router(appointments.router)
app.include_router(voice.router)
app.include_router(clients.router)
app.include_router(demo_chat.router)
app.include_router(portal.router)


@app.get("/")
async def root():
    return {"name": "SmartFlow AI", "version": "1.0.0", "status": "running"}


@app.get("/health")
async def health():
    return {"status": "healthy"}
