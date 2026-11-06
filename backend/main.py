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
            # Ensure missing columns exist in SQLite tables across versions
            try:
                # 1. Businesses table columns
                res = await conn.execute(text("PRAGMA table_info(businesses)"))
                b_cols = [row[1] for row in res.fetchall()]
                if "portal_token" not in b_cols:
                    await conn.execute(text("ALTER TABLE businesses ADD COLUMN portal_token VARCHAR(64)"))
                    logger.info("Migrated: added portal_token to businesses")
                if "portal_pin" not in b_cols:
                    await conn.execute(text("ALTER TABLE businesses ADD COLUMN portal_pin VARCHAR(20)"))
                    logger.info("Migrated: added portal_pin to businesses")
                if "logo_url" not in b_cols:
                    await conn.execute(text("ALTER TABLE businesses ADD COLUMN logo_url VARCHAR(500) DEFAULT ''"))
                    logger.info("Migrated: added logo_url to businesses")

                # 2. AI Settings table columns
                res = await conn.execute(text("PRAGMA table_info(ai_settings)"))
                ai_cols = [row[1] for row in res.fetchall()]
                ai_migrations = [
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
                    ("group_replies", "INTEGER DEFAULT 0"),
                    ("reply_delay", "INTEGER DEFAULT 0"),
                    ("typing_indicator", "INTEGER DEFAULT 0"),
                    ("reply_to_contacts", "INTEGER DEFAULT 1"),
                    ("auto_handover", "INTEGER DEFAULT 0"),
                    ("handover_after", "INTEGER DEFAULT 10"),
                    ("scoring_prompt", "TEXT DEFAULT ''"),
                ]
                for col_name, col_def in ai_migrations:
                    if col_name not in ai_cols:
                        await conn.execute(text(f"ALTER TABLE ai_settings ADD COLUMN {col_name} {col_def}"))
                        logger.info(f"Migrated: added {col_name} to ai_settings")

                # 3. Multi-client tenant business_id checks
                for tbl in ["leads", "conversations", "appointments", "working_hours"]:
                    res = await conn.execute(text(f"PRAGMA table_info({tbl})"))
                    tbl_cols = [row[1] for row in res.fetchall()]
                    if tbl_cols and "business_id" not in tbl_cols:
                        await conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN business_id INTEGER DEFAULT 1"))
                        logger.info(f"Migrated: added business_id to {tbl}")

                # 4. Clean up duplicate empty "My Business" records caused by crash-restart loops
                await conn.execute(text("""
                    DELETE FROM ai_settings WHERE business_id IN (
                        SELECT id FROM businesses WHERE name = 'My Business' AND id > 1
                        AND id NOT IN (SELECT business_id FROM leads)
                        AND id NOT IN (SELECT business_id FROM conversations)
                    )
                """))
                await conn.execute(text("""
                    DELETE FROM working_hours WHERE business_id IN (
                        SELECT id FROM businesses WHERE name = 'My Business' AND id > 1
                        AND id NOT IN (SELECT business_id FROM leads)
                        AND id NOT IN (SELECT business_id FROM conversations)
                    )
                """))
                cleanup_res = await conn.execute(text("""
                    DELETE FROM businesses WHERE name = 'My Business' AND id > 1
                    AND id NOT IN (SELECT business_id FROM leads)
                    AND id NOT IN (SELECT business_id FROM conversations)
                """))
                if cleanup_res.rowcount > 0:
                    logger.info(f"Cleaned up {cleanup_res.rowcount} duplicate empty 'My Business' records")
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
