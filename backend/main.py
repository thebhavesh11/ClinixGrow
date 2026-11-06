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
            await conn.execute(text("PRAGMA journal_mode=WAL;"))
            await conn.execute(text("PRAGMA busy_timeout=10000;"))
            await conn.run_sync(Base.metadata.create_all)
            # Ensure missing columns exist in SQLite tables across versions
            try:
                # Comprehensive Schema Migrations for all SQLite tables
                schema_migrations = {
                    "businesses": [
                        ("industry", "VARCHAR(100) DEFAULT ''"),
                        ("services", "TEXT DEFAULT ''"),
                        ("pricing", "TEXT DEFAULT ''"),
                        ("faqs", "TEXT DEFAULT ''"),
                        ("location", "VARCHAR(255) DEFAULT ''"),
                        ("offers", "TEXT DEFAULT ''"),
                        ("working_hours", "VARCHAR(255) DEFAULT ''"),
                        ("portal_token", "VARCHAR(64)"),
                        ("portal_pin", "VARCHAR(20)"),
                        ("logo_url", "VARCHAR(500) DEFAULT ''"),
                    ],
                    "leads": [
                        ("business_id", "INTEGER DEFAULT 1"),
                        ("lead_score", "INTEGER DEFAULT 0"),
                        ("lead_status", "VARCHAR(20) DEFAULT 'new'"),
                    ],
                    "conversations": [
                        ("business_id", "INTEGER DEFAULT 1"),
                    ],
                    "messages": [
                        ("sender_type", "VARCHAR(10) DEFAULT 'customer'"),
                        ("message_text", "TEXT DEFAULT ''"),
                    ],
                    "ai_settings": [
                        ("business_id", "INTEGER DEFAULT 1"),
                        ("provider", "VARCHAR(50) DEFAULT 'openai'"),
                        ("api_key", "VARCHAR(500) DEFAULT ''"),
                        ("model", "VARCHAR(100) DEFAULT 'gpt-4o-mini'"),
                        ("temperature", "FLOAT DEFAULT 0.7"),
                        ("max_tokens", "INTEGER DEFAULT 500"),
                        ("system_prompt", "TEXT DEFAULT ''"),
                        ("scoring_prompt", "TEXT DEFAULT ''"),
                        ("group_replies", "INTEGER DEFAULT 0"),
                        ("reply_delay", "INTEGER DEFAULT 0"),
                        ("typing_indicator", "INTEGER DEFAULT 0"),
                        ("reply_to_contacts", "INTEGER DEFAULT 1"),
                        ("auto_handover", "INTEGER DEFAULT 0"),
                        ("handover_after", "INTEGER DEFAULT 10"),
                        ("reminder_enabled", "INTEGER DEFAULT 0"),
                        ("reminder_time_mins", "INTEGER DEFAULT 30"),
                        ("reminder_message_template", "TEXT DEFAULT 'Hi {name}, this is a reminder for your appointment at {time}.'"),
                        ("feedback_enabled", "INTEGER DEFAULT 0"),
                        ("feedback_time_mins", "INTEGER DEFAULT 120"),
                        ("feedback_message_template", "TEXT DEFAULT 'Hi {name}, thank you for your visit! Please share your feedback: [Link]'"),
                        ("wa_connection_mode", "VARCHAR(20) DEFAULT 'qr'"),
                        ("wa_app_id", "VARCHAR(100) DEFAULT ''"),
                        ("wa_app_secret", "VARCHAR(255) DEFAULT ''"),
                        ("wa_phone_number_id", "VARCHAR(100) DEFAULT ''"),
                        ("wa_access_token", "VARCHAR(500) DEFAULT ''"),
                        ("wa_verify_token", "VARCHAR(100) DEFAULT ''"),
                        ("wa_business_account_id", "VARCHAR(100) DEFAULT ''"),
                    ],
                    "appointments": [
                        ("business_id", "INTEGER DEFAULT 1"),
                        ("lead_id", "INTEGER"),
                        ("title", "VARCHAR(255) DEFAULT 'Appointment'"),
                        ("notes", "TEXT DEFAULT ''"),
                        ("booked_by", "VARCHAR(20) DEFAULT 'manual'"),
                        ("reminder_sent", "INTEGER DEFAULT 0"),
                        ("feedback_sent", "INTEGER DEFAULT 0"),
                        ("status", "VARCHAR(20) DEFAULT 'confirmed'"),
                    ],
                    "working_hours": [
                        ("business_id", "INTEGER DEFAULT 1"),
                        ("break_start", "VARCHAR(5) DEFAULT ''"),
                        ("break_end", "VARCHAR(5) DEFAULT ''"),
                        ("slot_duration", "INTEGER DEFAULT 30"),
                        ("is_open", "INTEGER DEFAULT 1"),
                    ],
                    "business_media": [
                        ("business_id", "INTEGER DEFAULT 1"),
                        ("name", "VARCHAR(255) DEFAULT ''"),
                        ("description", "TEXT DEFAULT ''"),
                        ("file_type", "VARCHAR(20) DEFAULT 'image'"),
                        ("file_path", "VARCHAR(500) DEFAULT ''"),
                        ("original_filename", "VARCHAR(255) DEFAULT ''"),
                    ],
                    "voice_settings": [
                        ("business_id", "INTEGER DEFAULT 1"),
                        ("vapi_api_key", "VARCHAR(500) DEFAULT ''"),
                        ("vapi_assistant_id", "VARCHAR(100) DEFAULT ''"),
                        ("vapi_phone_id", "VARCHAR(100) DEFAULT ''"),
                        ("phone_number", "VARCHAR(20) DEFAULT ''"),
                        ("agent_name", "VARCHAR(255) DEFAULT 'AI Assistant'"),
                        ("voice_provider", "VARCHAR(50) DEFAULT '11labs'"),
                        ("voice_id", "VARCHAR(100) DEFAULT ''"),
                        ("language", "VARCHAR(10) DEFAULT 'hi-IN'"),
                        ("first_message", "TEXT DEFAULT 'Hello! How can I help you today?'"),
                        ("system_prompt", "TEXT DEFAULT ''"),
                        ("can_book_appointments", "INTEGER DEFAULT 1"),
                        ("can_transfer_call", "INTEGER DEFAULT 1"),
                        ("webhook_secret", "VARCHAR(100) DEFAULT ''"),
                        ("is_active", "INTEGER DEFAULT 0"),
                    ],
                    "call_logs": [
                        ("business_id", "INTEGER DEFAULT 1"),
                        ("lead_id", "INTEGER"),
                        ("vapi_call_id", "VARCHAR(100) DEFAULT ''"),
                        ("phone_number", "VARCHAR(20) DEFAULT ''"),
                        ("direction", "VARCHAR(10) DEFAULT 'inbound'"),
                        ("status", "VARCHAR(20) DEFAULT 'queued'"),
                        ("duration_seconds", "INTEGER DEFAULT 0"),
                        ("cost", "FLOAT DEFAULT 0.0"),
                        ("recording_url", "VARCHAR(500) DEFAULT ''"),
                        ("transcript", "TEXT DEFAULT ''"),
                        ("summary", "TEXT DEFAULT ''"),
                        ("ended_reason", "VARCHAR(50) DEFAULT ''"),
                        ("appointments_booked", "INTEGER DEFAULT 0"),
                    ],
                }

                for tbl_name, cols in schema_migrations.items():
                    try:
                        res = await conn.execute(text(f"PRAGMA table_info({tbl_name})"))
                        existing_cols = {row[1] for row in res.fetchall()}
                        if existing_cols:
                            for col_name, col_def in cols:
                                if col_name not in existing_cols:
                                    await conn.execute(text(f"ALTER TABLE {tbl_name} ADD COLUMN {col_name} {col_def}"))
                                    logger.info(f"Migrated: added {col_name} to {tbl_name}")
                    except Exception as tbl_err:
                        logger.warning(f"Column migration warning for {tbl_name}: {tbl_err}")
            except Exception as mig_err:
                logger.warning(f"Column migration check warning: {mig_err}")

        logger.info("Database tables created/verified")

        # Seed default business & AI settings ONLY if database has NO businesses at all
        async with async_session() as session:
            async with session.begin():
                any_biz = (await session.execute(select(Business))).scalars().first()
                if not any_biz:
                    session.add(Business(id=1, name="My Business", portal_token=f"portal_{secrets.token_urlsafe(16)}"))
                    await session.flush()
                    logger.info("Seeded default business profile")

                # Ensure all businesses have a portal_token
                all_bizs = (await session.execute(select(Business))).scalars().all()
                for b in all_bizs:
                    if not b.portal_token:
                        b.portal_token = f"portal_{secrets.token_urlsafe(16)}"
                        logger.info(f"Generated portal_token for {b.name}: {b.portal_token}")

                # Ensure each business has AI settings
                for b in all_bizs:
                    ai_r = await session.execute(select(AISetting).where(AISetting.business_id == b.id))
                    if not ai_r.scalar_one_or_none():
                        session.add(AISetting(business_id=b.id))
                        logger.info(f"Seeded default AI settings for business {b.id}")

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
