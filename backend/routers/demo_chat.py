"""Demo Chat router — test AI without WhatsApp connection."""

import re
import logging
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from database import get_db
from models import Lead, Conversation, Message, AISetting, Business, BusinessMedia, Appointment, WorkingHours

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/demo-chat", tags=["Demo Chat"])

DEMO_PHONE = "demo-test-000"


@router.post("/send")
async def demo_send(body: dict, db: AsyncSession = Depends(get_db)):
    """Send a message as a demo customer and get AI reply directly."""
    bid = body.get("business_id", 1)
    message = (body.get("message") or "").strip()
    if not message:
        return {"error": "Message cannot be empty"}

    try:
        # 1. Find or create demo lead
        result = await db.execute(
            select(Lead).where(Lead.phone_number == DEMO_PHONE, Lead.business_id == bid)
        )
        lead = result.scalar_one_or_none()
        if not lead:
            lead = Lead(phone_number=DEMO_PHONE, name="Demo Customer", business_id=bid)
            db.add(lead)
            await db.flush()
            await db.refresh(lead)

        # 2. Find or create conversation
        result = await db.execute(
            select(Conversation).where(Conversation.lead_id == lead.id, Conversation.business_id == bid)
        )
        conv = result.scalar_one_or_none()
        if not conv:
            conv = Conversation(lead_id=lead.id, business_id=bid)
            db.add(conv)
            await db.flush()
            await db.refresh(conv)

        # 3. Save customer message
        db.add(Message(conversation_id=conv.id, sender_type="customer", message_text=message))
        await db.flush()

        # 4. Load AI settings, business, media
        ai_settings = (await db.execute(select(AISetting).where(AISetting.business_id == bid))).scalar_one_or_none()
        business = (await db.execute(select(Business).where(Business.id == bid))).scalar_one_or_none()
        media_files = (await db.execute(select(BusinessMedia).where(BusinessMedia.business_id == bid))).scalars().all()

        # 5. Build history
        result = await db.execute(
            select(Message).where(Message.conversation_id == conv.id)
            .order_by(Message.created_at.desc()).limit(10)
        )
        history = list(reversed(result.scalars().all()))

        # 6. Generate AI reply
        from automation.engine import generate_ai_reply, _build_appointment_context

        appt_context = await _build_appointment_context(db, bid, lead.id)
        ai_reply = await generate_ai_reply(ai_settings, business, history, message, media_files, appt_context)

        # 7. Parse [BOOK: Date | Time | Details] tags for appointments
        book_match = re.search(r'\[BOOK:\s*([^|]+)\|\s*([^|]+)\|\s*([^\]]+)\]', ai_reply, re.IGNORECASE)
        booked = []
        if book_match:
            appt_date, appt_time, details = book_match.groups()
            appt_date = appt_date.strip()
            appt_time = appt_time.strip()
            try:
                target_dt = datetime.strptime(appt_date, "%Y-%m-%d")
                wh = (await db.execute(
                    select(WorkingHours).where(WorkingHours.business_id == bid, WorkingHours.day_of_week == target_dt.weekday())
                )).scalar_one_or_none()
                duration = wh.slot_duration if wh else 30
                end_time = (datetime.strptime(appt_time, "%H:%M") + timedelta(minutes=duration)).strftime("%H:%M")

                conflicts = (await db.execute(
                    select(Appointment).where(Appointment.business_id == bid, Appointment.date == appt_date, Appointment.status == "confirmed")
                )).scalars().all()
                if not any(not (end_time <= c.start_time or appt_time >= c.end_time) for c in conflicts):
                    db.add(Appointment(business_id=bid, lead_id=lead.id, title=details.strip()[:100],
                                       date=appt_date, start_time=appt_time, end_time=end_time,
                                       status="confirmed", booked_by="ai-demo"))
                    await db.flush()
                    booked.append({"date": appt_date, "time": appt_time, "end_time": end_time})
                    logger.info(f"[DemoChat] Booked: {appt_date} {appt_time}-{end_time}")
            except Exception as e:
                logger.error(f"[DemoChat] Booking error: {e}")

        # 8. Clean tags
        clean_reply = re.sub(r'\s*\[BOOK:.*?\]\s*', ' ', ai_reply, flags=re.IGNORECASE).strip()
        clean_reply = re.sub(r'\s*\[MEDIA:\d+\]\s*', ' ', clean_reply).strip()

        # 9. Save AI reply
        db.add(Message(conversation_id=conv.id, sender_type="ai", message_text=clean_reply))
        await db.flush()

        return {"reply": clean_reply, "conversation_id": conv.id, "booked_appointments": booked}

    except Exception as e:
        logger.error(f"[DemoChat] Error: {type(e).__name__}: {e}", exc_info=True)
        return {"error": f"{type(e).__name__}: {e}", "reply": None}


@router.get("/history")
async def demo_history(business_id: int = 1, db: AsyncSession = Depends(get_db)):
    """Get demo chat history."""
    lead = (await db.execute(
        select(Lead).where(Lead.phone_number == DEMO_PHONE, Lead.business_id == business_id)
    )).scalar_one_or_none()
    if not lead:
        return []
    conv = (await db.execute(
        select(Conversation).where(Conversation.lead_id == lead.id, Conversation.business_id == business_id)
    )).scalar_one_or_none()
    if not conv:
        return []
    messages = (await db.execute(
        select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at.asc())
    )).scalars().all()
    return [{"id": m.id, "sender_type": m.sender_type, "message_text": m.message_text, "created_at": str(m.created_at)} for m in messages]


@router.delete("/clear")
async def demo_clear(business_id: int = 1, db: AsyncSession = Depends(get_db)):
    """Clear demo chat history and appointments."""
    lead = (await db.execute(
        select(Lead).where(Lead.phone_number == DEMO_PHONE, Lead.business_id == business_id)
    )).scalar_one_or_none()
    if not lead:
        return {"success": True, "message": "Nothing to clear"}

    conv = (await db.execute(
        select(Conversation).where(Conversation.lead_id == lead.id, Conversation.business_id == business_id)
    )).scalar_one_or_none()

    deleted_msgs = 0
    if conv:
        deleted_msgs = (await db.execute(delete(Message).where(Message.conversation_id == conv.id))).rowcount
        await db.execute(delete(Conversation).where(Conversation.id == conv.id))

    deleted_appts = (await db.execute(
        delete(Appointment).where(Appointment.lead_id == lead.id, Appointment.business_id == business_id)
    )).rowcount
    await db.execute(delete(Lead).where(Lead.id == lead.id))

    logger.info(f"[DemoChat] Cleared: {deleted_msgs} msgs, {deleted_appts} appts")
    return {"success": True, "deleted_messages": deleted_msgs, "deleted_appointments": deleted_appts}
