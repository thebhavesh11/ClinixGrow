"""Background appointment reminder — sends WhatsApp message 1 hour before appointment."""

import os
import asyncio
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, and_
from database import async_session
from models import Appointment, Lead, AISetting

logger = logging.getLogger(__name__)

BRIDGE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://localhost:3001")
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")

# Check every 2 minutes
CHECK_INTERVAL = 120


async def send_automation_message(phone: str, message: str, settings):
    """Send a WhatsApp message using the active connection mode."""
    import httpx
    wa_mode = getattr(settings, 'wa_connection_mode', 'qr') or 'qr'
    try:
        if wa_mode == "cloud_api":
            from routers.whatsapp import _send_cloud_api_text
            result = await _send_cloud_api_text(phone, message, settings)
            if result.get("success"):
                return True
            else:
                logger.error(f"[Automation] Cloud API send failed: {result.get('error')}")
                return False
        else:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"{BRIDGE_URL}/send",
                    json={"phone": phone, "message": message},
                )
                resp = r.json()
                if resp.get("success", True):
                    return True
                else:
                    logger.error(f"[Automation] Bridge send failed: {resp.get('error')}")
                    return False
    except Exception as e:
        logger.error(f"[Automation] ❌ Failed to send message to {phone}: {type(e).__name__}: {e}")
        return False


async def check_and_send_automations():
    """Check for upcoming and past appointments to send reminders and feedback."""
    try:
        async with async_session() as session:
            async with session.begin():
                now = datetime.utcnow()
                
                # We fetch all confirmed appointments that haven't had both automations sent
                result = await session.execute(
                    select(Appointment).where(
                        Appointment.status == "confirmed",
                        Appointment.lead_id.isnot(None),
                        (Appointment.reminder_sent == 0) | (Appointment.feedback_sent == 0)
                    )
                )
                appointments = result.scalars().all()

                if not appointments:
                    return

                # Pre-fetch settings to avoid redundant queries
                settings_cache = {}
                lead_cache = {}

                for appt in appointments:
                    try:
                        # Load settings
                        if appt.business_id not in settings_cache:
                            s_res = await session.execute(select(AISetting).where(AISetting.business_id == appt.business_id))
                            settings_cache[appt.business_id] = s_res.scalar_one_or_none()
                        
                        settings = settings_cache[appt.business_id]
                        if not settings:
                            continue

                        # Check if any automation is enabled
                        if not settings.reminder_enabled and not settings.feedback_enabled:
                            continue

                        appt_start = datetime.strptime(f"{appt.date} {appt.start_time}", "%Y-%m-%d %H:%M")
                        # Default end time to start + 30 mins if not provided
                        end_time_str = appt.end_time if appt.end_time else (appt_start + timedelta(minutes=30)).strftime("%H:%M")
                        appt_end = datetime.strptime(f"{appt.date} {end_time_str}", "%Y-%m-%d %H:%M")

                        # Load Lead
                        if appt.lead_id not in lead_cache:
                            l_res = await session.execute(select(Lead).where(Lead.id == appt.lead_id))
                            lead_cache[appt.lead_id] = l_res.scalar_one_or_none()
                        
                        lead = lead_cache[appt.lead_id]
                        if not lead or not lead.phone_number:
                            continue

                        # --- 1. REMINDERS ---
                        if settings.reminder_enabled == 1 and appt.reminder_sent == 0:
                            time_to_appt = (appt_start - now).total_seconds()
                            
                            # If appointment is in the future and within the reminder window
                            if 0 < time_to_appt <= settings.reminder_time_mins * 60:
                                msg = settings.reminder_message_template or "Hi {name}, your appointment is at {time}."
                                msg = msg.replace("{name}", lead.name).replace("{time}", appt.start_time)
                                
                                success = await send_automation_message(lead.phone_number, msg, settings)
                                if success:
                                    logger.info(f"[Automation] ✅ Sent reminder to {lead.phone_number} for {appt.start_time}")
                                    appt.reminder_sent = 1

                        # --- 2. FEEDBACK ---
                        if settings.feedback_enabled == 1 and appt.feedback_sent == 0:
                            time_since_appt = (now - appt_end).total_seconds()
                            
                            # If appointment has passed by feedback_time_mins
                            # We add a 24-hour limit so we don't spam appointments from 2 years ago
                            if settings.feedback_time_mins * 60 <= time_since_appt <= (settings.feedback_time_mins * 60 + 86400):
                                msg = settings.feedback_message_template or "Hi {name}, please leave us a review!"
                                msg = msg.replace("{name}", lead.name)
                                
                                success = await send_automation_message(lead.phone_number, msg, settings)
                                if success:
                                    logger.info(f"[Automation] ✅ Sent feedback request to {lead.phone_number}")
                                    appt.feedback_sent = 1

                    except Exception as e:
                        logger.error(f"[Automation] Error processing appointment {appt.id}: {type(e).__name__}: {e}")
                
                await session.flush()

    except Exception as e:
        logger.error(f"[Automation] Background check error: {type(e).__name__}: {e}")


async def reminder_loop():
    """Background loop that checks for automations every CHECK_INTERVAL seconds."""
    logger.info(f"[Automation] Background automation service started (check every {CHECK_INTERVAL}s)")
    while True:
        await asyncio.sleep(CHECK_INTERVAL)
        try:
            await check_and_send_automations()
        except Exception as e:
            logger.error(f"[Automation] Loop error: {type(e).__name__}: {e}")
