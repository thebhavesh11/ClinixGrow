"""Automation engine — orchestrates message processing pipeline."""

import os
import re
import json
import asyncio
import logging
import httpx
from datetime import datetime, timedelta
from collections import OrderedDict
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_
from models import Lead, Conversation, Message, AISetting, Business, BusinessMedia, Appointment, WorkingHours

logger = logging.getLogger(__name__)

BRIDGE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3001")
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8000")

# Per-phone lock: ensures messages from the same customer are processed one at a time
# Uses OrderedDict with a max cap to prevent unbounded memory growth
_MAX_PHONE_LOCKS = 10000
_phone_locks: OrderedDict[str, asyncio.Lock] = OrderedDict()


def _get_phone_lock(phone: str) -> asyncio.Lock:
    """Get or create a lock for a phone number, with LRU eviction."""
    if phone in _phone_locks:
        _phone_locks.move_to_end(phone)
        return _phone_locks[phone]
    # Evict oldest entries if over capacity
    while len(_phone_locks) >= _MAX_PHONE_LOCKS:
        _phone_locks.popitem(last=False)
    _phone_locks[phone] = asyncio.Lock()
    return _phone_locks[phone]


async def _send_typing_to_bridge(target_id: str, business_id: int):
    """Trigger WhatsApp live typing state ('typing...') in the bridge."""
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            await client.post(f"{BRIDGE_URL}/typing", json={"phone": target_id, "business_id": business_id})
            logger.info(f"[Engine] Triggered live typing indicator for {target_id} (biz={business_id})")
    except Exception as e:
        logger.debug(f"[Engine] Typing request error: {e}")


async def process_incoming_message(
    phone: str, message: str, name: str, business_id: int, db: AsyncSession, reply_to: str = None, should_reply: bool = True, alt_phone: str = None
) -> dict:
    """Process an incoming WhatsApp message end-to-end (sequential per phone)."""
    lock = _get_phone_lock(phone)
    async with lock:
        return await _process_message_inner(phone, message, name, business_id, db, reply_to, should_reply, alt_phone)


async def _process_message_inner(
    phone: str, message: str, name: str, business_id: int, db: AsyncSession, reply_to: str = None, should_reply: bool = True, alt_phone: str = None
) -> dict:
    """Internal message processing — runs under per-phone lock."""
    # 0. Do not create lead, conversation, or message if message is completely empty
    if not message or not str(message).strip():
        logger.info(f"[Engine] Ignoring empty message from {phone} (biz={business_id})")
        return {"reply": None, "skipped": True}

    phone_clean = phone.strip()
    alt_clean = (alt_phone or "").strip()

    # 1. Find or create lead (scoped to business, match primary or alt LID/phone)
    conditions = [Lead.phone_number == phone_clean]
    if alt_clean and alt_clean != phone_clean:
        conditions.append(Lead.phone_number == alt_clean)

    result = await db.execute(
        select(Lead).where(Lead.business_id == business_id, or_(*conditions))
    )
    lead = result.scalar_one_or_none()
    if not lead:
        lead = Lead(phone_number=phone_clean, name=name or "Unknown", business_id=business_id)
        db.add(lead)
        await db.flush()
        await db.refresh(lead)
        logger.info(f"[Engine] Created new lead for biz {business_id}: {lead.name} ({lead.phone_number})")
    else:
        # If existing lead has LID and we now have clean real phone number, upgrade it
        if alt_clean and lead.phone_number == alt_clean and phone_clean != alt_clean:
            lead.phone_number = phone_clean
        if name and name != "Unknown" and (not lead.name or lead.name == "Unknown"):
            lead.name = name
        await db.flush()

    # 2. Find or create conversation
    result = await db.execute(
        select(Conversation).where(
            Conversation.lead_id == lead.id,
            Conversation.business_id == business_id,
        )
    )
    conv = result.scalar_one_or_none()
    if not conv:
        conv = Conversation(lead_id=lead.id, business_id=business_id)
        db.add(conv)
        await db.flush()
        await db.refresh(conv)

    # 3. Clean raw base64 image strings if received
    saved_text = message.strip()
    if saved_text.startswith('/9j/') or saved_text.startswith('data:image') or (len(saved_text) > 300 and ' ' not in saved_text):
        saved_text = '[Photo received]'

    # Save incoming message so it is ALWAYS visible in the UI
    customer_msg = Message(
        conversation_id=conv.id,
        sender_type="customer",
        message_text=saved_text,
    )
    db.add(customer_msg)
    await db.flush()

    # 3b. Check if lead is handed over — AI should not reply
    if lead.lead_status == 'handover':
        logger.info(f"[Engine] Lead {lead.phone_number} is handed over — skipping AI reply")
        return {"reply": None, "lead_id": lead.id, "handover": True}

    # 3c. Check should_reply flag and message content
    if not should_reply or not message.strip():
        logger.info(f"[Engine] Message from {phone} saved for UI display; skipping AI reply (should_reply={should_reply}, has_text={bool(message.strip())})")
        return {"reply": None, "lead_id": lead.id, "skipped": True}

    # 4. Get AI settings and business info
    result = await db.execute(select(AISetting).where(AISetting.business_id == business_id))
    ai_settings = result.scalar_one_or_none()

    result = await db.execute(select(Business).where(Business.id == business_id))
    business = result.scalar_one_or_none()

    # 4b. Get business media catalog
    result = await db.execute(select(BusinessMedia).where(BusinessMedia.business_id == business_id))
    media_files = result.scalars().all()

    # 5. Build conversation history
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conv.id)
        .order_by(Message.created_at.desc())
        .limit(10)
    )
    history = list(reversed(result.scalars().all()))

    # Trigger live typing indicator immediately so customer sees "typing..." while AI generates reply!
    wa_mode = getattr(ai_settings, 'wa_connection_mode', 'qr') or 'qr'
    show_typing = bool(getattr(ai_settings, 'typing_indicator', 0))
    target_id = reply_to if reply_to else phone

    if show_typing and wa_mode == "qr":
        try:
            asyncio.create_task(_send_typing_to_bridge(target_id, business_id))
        except Exception as te:
            logger.debug(f"[Engine] Immediate typing trigger error: {te}")

    # 6. Generate AI reply
    # 6a. Build appointment context for AI
    appt_context = await _build_appointment_context(db, business_id, lead.id)
    ai_reply = await generate_ai_reply(ai_settings, business, history, message, media_files, appt_context)

    # 7. Parse [BOOK: Date | Time | Details] tags for appointments
    book_match = re.search(r'\[BOOK:\s*([^|]+)\|\s*([^|]+)\|\s*([^\]]+)\]', ai_reply, re.IGNORECASE)
    if book_match:
        date_str, time_str, details = book_match.groups()
        try:
            new_appt = Appointment(
                business_id=business_id,
                lead_id=lead.id,
                title=details.strip()[:100],
                date=date_str.strip(),
                start_time=time_str.strip(),
                status="confirmed",
                booked_by="ai"
            )
            db.add(new_appt)
            ai_reply = re.sub(r'\s*\[BOOK:.*?\]\s*', ' ', ai_reply, flags=re.IGNORECASE).strip()
        except Exception as e:
            logger.error(f"Error booking appointment via tag: {e}")

    # 8. Parse [MEDIA:ID] tags and send media files
    media_tags = re.findall(r'\[MEDIA:(\d+)\]', ai_reply)
    clean_reply = re.sub(r'\s*\[MEDIA:\d+\]\s*', ' ', ai_reply).strip()

    if media_tags:
        # Determine connection mode
        wa_mode = getattr(ai_settings, 'wa_connection_mode', 'qr') or 'qr'
        media_map = {m.id: m for m in media_files}
        for tag_id in media_tags:
            mid = int(tag_id)
            if mid in media_map:
                m = media_map[mid]
                try:
                    target_id = reply_to if reply_to else phone
                    if wa_mode == "cloud_api":
                        from routers.whatsapp import send_cloud_api_media
                        await send_cloud_api_media(
                            phone=target_id,
                            media_url=f"{BACKEND_URL}/api/media/file/{m.id}",
                            filename=m.original_filename,
                            caption=m.name,
                            settings=ai_settings,
                        )
                    else:
                        async with httpx.AsyncClient(timeout=30) as client:
                            await client.post(
                                f"{BRIDGE_URL}/send-media",
                                json={
                                    "phone": target_id,
                                    "mediaUrl": f"{BACKEND_URL}/api/media/file/{m.id}",
                                    "filename": m.original_filename,
                                    "caption": m.name,
                                    "business_id": business_id,
                                },
                            )
                    logger.info(f"[Engine] Sent media '{m.name}' to {target_id} via {wa_mode}")
                except httpx.TimeoutException:
                    logger.error(f"[Engine] Media send timed out for '{m.name}' to {phone}")
                except Exception as e:
                    logger.error(f"[Engine] Failed to send media: {type(e).__name__}: {e}")

    # 8. Save AI reply (clean version without tags)
    ai_msg = Message(
        conversation_id=conv.id,
        sender_type="ai",
        message_text=clean_reply,
    )
    db.add(ai_msg)
    await db.flush()

    # 8a. Parse [APPT:DATE|TIME] tags and auto-book appointments
    appt_tags = re.findall(r'\[APPT:(\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2})\]', ai_reply)
    clean_reply = re.sub(r'\s*\[APPT:\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}\]\s*', ' ', clean_reply).strip()
    # Update the saved message with clean text (remove APPT tags too)
    ai_msg.message_text = clean_reply
    await db.flush()

    for appt_date, appt_time in appt_tags:
        try:
            # Get slot duration from working hours
            target_dt = datetime.strptime(appt_date, "%Y-%m-%d")
            wh_result = await db.execute(
                select(WorkingHours).where(
                    WorkingHours.business_id == business_id,
                    WorkingHours.day_of_week == target_dt.weekday(),
                )
            )
            wh = wh_result.scalar_one_or_none()
            duration = wh.slot_duration if wh else 30
            st = datetime.strptime(appt_time, "%H:%M")
            end_time = (st + timedelta(minutes=duration)).strftime("%H:%M")

            # Check if slot is actually available (no conflict)
            conflict_result = await db.execute(
                select(Appointment).where(
                    Appointment.business_id == business_id,
                    Appointment.date == appt_date,
                    Appointment.status == "confirmed",
                )
            )
            conflicts = conflict_result.scalars().all()
            has_conflict = any(
                not (end_time <= c.start_time or appt_time >= c.end_time)
                for c in conflicts
            )

            if not has_conflict:
                new_appt = Appointment(
                    business_id=business_id,
                    lead_id=lead.id,
                    title="Appointment",
                    date=appt_date,
                    start_time=appt_time,
                    end_time=end_time,
                    status="confirmed",
                    booked_by="ai",
                )
                db.add(new_appt)
                await db.flush()
                logger.info(f"[Engine] ✅ AI booked appointment for {phone}: {appt_date} {appt_time}-{end_time}")
            else:
                logger.warning(f"[Engine] ⚠ AI tried to book conflicting slot: {appt_date} {appt_time}")
        except Exception as e:
            logger.error(f"[Engine] Appointment booking error: {type(e).__name__}: {e}")

    # 8b. Check auto-handover: count AI messages and mark lead if limit reached
    auto_handover = getattr(ai_settings, 'auto_handover', 0) or 0
    handover_limit = getattr(ai_settings, 'handover_after', 10) or 10
    if auto_handover:
        result = await db.execute(
            select(func.count()).where(
                Message.conversation_id == conv.id,
                Message.sender_type == 'ai',
            )
        )
        ai_msg_count = result.scalar() or 0
        if ai_msg_count >= handover_limit:
            lead.lead_status = 'handover'
            await db.flush()
            logger.info(f"[Engine] Lead {lead.phone_number} auto-handed over after {ai_msg_count} AI replies")

    # 8c. Apply reply delay + typing indicator to avoid WhatsApp bans
    wa_mode = getattr(ai_settings, 'wa_connection_mode', 'qr') or 'qr'
    delay = getattr(ai_settings, 'reply_delay', 0) or 0
    show_typing = getattr(ai_settings, 'typing_indicator', 0) or 0
    target_id = reply_to if reply_to else phone

    if delay > 0:
        # Typing indicator only works in QR mode (Cloud API doesn't support it)
        if show_typing and wa_mode == "qr":
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    await client.post(f"{BRIDGE_URL}/typing", json={"phone": target_id, "business_id": business_id})
                logger.info(f"[Engine] Typing indicator sent to {target_id}")
            except Exception as e:
                logger.warning(f"[Engine] Failed to send typing: {type(e).__name__}: {e}")
        logger.info(f"[Engine] Waiting {delay}s before replying...")
        await asyncio.sleep(delay)

    # 9. Send text reply via WhatsApp (routes based on connection mode)
    if clean_reply:
        try:
            if wa_mode == "cloud_api":
                from routers.whatsapp import _send_cloud_api_text
                result = await _send_cloud_api_text(phone, clean_reply, ai_settings)
                if result.get("success"):
                    logger.info(f"[Engine] Replied to {phone} via Cloud API: {clean_reply[:50]}...")
                else:
                    logger.error(f"[Engine] Cloud API send failed: {result.get('error')}")
            else:
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.post(
                        f"{BRIDGE_URL}/send",
                        json={"phone": target_id, "message": clean_reply, "business_id": business_id},
                    )
                logger.info(f"[Engine] Replied to {target_id} via QR bridge: {clean_reply[:50]}...")
        except httpx.TimeoutException:
            logger.error(f"[Engine] Reply send timed out for {target_id}")
        except Exception as e:
            logger.error(f"[Engine] Failed to send reply: {type(e).__name__}: {e}")

    # 10. Score lead (fire-and-forget — errors don't affect the reply)
    try:
        await score_lead(lead, ai_settings, history, db)
    except Exception as e:
        logger.error(f"[Engine] Lead scoring failed (non-critical): {type(e).__name__}: {e}")

    return {"reply": clean_reply, "lead_id": lead.id}


async def record_outgoing_human_message(
    phone: str,
    message: str,
    name: str = "Unknown",
    business_id: int = 1,
    alt_phone: str = None,
    db: AsyncSession = None,
) -> dict:
    """Record an outgoing message sent manually by the user from their WhatsApp phone/web."""
    if not message or not str(message).strip():
        return {"skipped": True}

    phone_clean = phone.strip()
    alt_clean = (alt_phone or "").strip()

    async with _get_phone_lock(phone_clean):
        # 1. Find or create lead (scoped to business, match primary phone or alternate LID)
        conditions = [Lead.phone_number == phone_clean]
        if alt_clean and alt_clean != phone_clean:
            conditions.append(Lead.phone_number == alt_clean)

        result = await db.execute(
            select(Lead).where(Lead.business_id == business_id, or_(*conditions))
        )
        lead = result.scalar_one_or_none()
        if not lead:
            lead = Lead(phone_number=phone_clean, name=name or "Unknown", business_id=business_id)
            db.add(lead)
            await db.flush()
            await db.refresh(lead)
            logger.info(f"[Engine] Created new lead for outgoing WhatsApp message: {lead.name} ({lead.phone_number})")
        else:
            # If lead had LID and we now have clean real phone number, upgrade it
            if alt_clean and lead.phone_number == alt_clean and phone_clean != alt_clean:
                lead.phone_number = phone_clean
            if name and name != "Unknown" and (not lead.name or lead.name == "Unknown"):
                lead.name = name
            await db.flush()

        # 2. Find or create conversation
        result = await db.execute(
            select(Conversation).where(
                Conversation.lead_id == lead.id,
                Conversation.business_id == business_id,
            )
        )
        conv = result.scalar_one_or_none()
        if not conv:
            conv = Conversation(lead_id=lead.id, business_id=business_id)
            db.add(conv)
            await db.flush()
            await db.refresh(conv)

        # 3. Clean raw base64 image strings if outgoing media
        clean_text = message.strip()
        if clean_text.startswith('/9j/') or clean_text.startswith('data:image') or (len(clean_text) > 300 and ' ' not in clean_text):
            clean_text = '[Photo sent]'

        # Save message with sender_type="human" so it appears as "👤 You" in dashboard
        human_msg = Message(
            conversation_id=conv.id,
            sender_type="human",
            message_text=clean_text,
        )
        db.add(human_msg)
        await db.flush()

        logger.info(f"[Engine] Recorded manual WhatsApp message from owner to {phone_clean} (conv={conv.id})")
        return {"lead_id": lead.id, "conversation_id": conv.id, "message_id": human_msg.id}


async def _build_appointment_context(db: AsyncSession, business_id: int, lead_id: int) -> str:
    """Build appointment context string for AI system prompt."""
    from routers.appointments import _generate_slots

    lines = []
    today = datetime.utcnow()
    today_str = today.strftime("%Y-%m-%d")
    day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    lines.append(f"Today is {today.strftime('%Y-%m-%d')} ({day_names[today.weekday()]}).")
    lines.append("You can book appointments for the customer. To book, include [APPT:YYYY-MM-DD|HH:MM] in your reply.")
    lines.append("Only book slots that are listed as available below. Never book a slot that is not listed.")
    lines.append("")

    # Get working hours
    result = await db.execute(
        select(WorkingHours)
        .where(WorkingHours.business_id == business_id)
        .order_by(WorkingHours.day_of_week)
    )
    wh_all = {wh.day_of_week: wh for wh in result.scalars().all()}

    # Get appointments for next 7 days
    date_range = [(today + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
    result = await db.execute(
        select(Appointment).where(
            Appointment.business_id == business_id,
            Appointment.date.in_(date_range),
            Appointment.status == "confirmed",
        )
    )
    all_appts = result.scalars().all()
    appts_by_date = {}
    for a in all_appts:
        appts_by_date.setdefault(a.date, []).append(a)

    lines.append("Available slots (next 7 days):")
    for i in range(7):
        dt = today + timedelta(days=i)
        date_str = dt.strftime("%Y-%m-%d")
        day_name = day_names[dt.weekday()]
        wh = wh_all.get(dt.weekday())

        if not wh or not wh.is_open:
            lines.append(f"- {date_str} ({day_name}): CLOSED")
            continue

        all_slots = _generate_slots(
            wh.start_time, wh.end_time, wh.slot_duration,
            wh.break_start or "", wh.break_end or "",
        )

        booked = appts_by_date.get(date_str, [])
        booked_times = {(a.start_time, a.end_time) for a in booked}

        available = []
        for slot in all_slots:
            is_booked = any(
                not (slot["end_time"] <= b_start or slot["time"] >= b_end)
                for b_start, b_end in booked_times
            )
            if not is_booked:
                available.append(slot["time"])

        if available:
            # Show max 10 slots to keep prompt short
            display = available[:10]
            extra = f" ... +{len(available)-10} more" if len(available) > 10 else ""
            lines.append(f"- {date_str} ({day_name}): {', '.join(display)}{extra}")
        else:
            lines.append(f"- {date_str} ({day_name}): FULLY BOOKED")

    # Add lead's existing appointments
    result = await db.execute(
        select(Appointment).where(
            Appointment.lead_id == lead_id,
            Appointment.status == "confirmed",
            Appointment.date >= today_str,
        ).order_by(Appointment.date, Appointment.start_time)
    )
    lead_appts = result.scalars().all()
    if lead_appts:
        lines.append("")
        lines.append("This customer's existing appointments:")
        for a in lead_appts:
            lines.append(f"- {a.date} {a.start_time}-{a.end_time} ({a.status})")

    return "\n".join(lines)


def _clean_ai_reply(raw: str) -> str:
    """Strip internal reasoning / monologue that some models leak."""
    if not raw:
        return ""
    text = str(raw).strip()
    if not text:
        return ""

    # 1. Remove <think>...</think> blocks (DeepSeek, etc.)
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()

    # 2. Handle text starting with '(' — use bracket counting to find matching ')'
    if text.startswith('(') and len(text) > 30:
        depth = 0
        close_pos = -1
        for i, ch in enumerate(text):
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    close_pos = i
                    break
        if close_pos > 0:
            reasoning_block = text[:close_pos + 1]
            after_block = text[close_pos + 1:].strip()
            # If there's real content AFTER the parentheses, use that
            if after_block and len(after_block) > 10:
                text = after_block
            elif len(reasoning_block) > 30:
                # Entire reply is reasoning — extract the best reply from within
                text = _extract_reply_from_reasoning(reasoning_block[1:-1])

    # 3. Detect reasoning even without parentheses (some models dump raw thoughts)
    reasoning_markers = ['let me ', 'i need to ', 'i should ', 'i must ', 'checking ',
                         'looking at ', 'analyzing ', 'the user ', 'my response ',
                         'word count', 'draft:', 'alternative:', 'best approach:',
                         "here's a thinking process", "thinking process:", "here is a thinking process",
                         "we need ", "need to ", "the customer ", "they provided ", "we should ",
                         "as per instruction", "first step", "infer "]
    lines = text.split('\n')
    if len(lines) > 3 or any(marker in text[:300].lower() for marker in reasoning_markers):
        if any(marker in text[:400].lower() for marker in reasoning_markers):
            # Looks like reasoning dump — try to extract actual reply
            extracted = _extract_reply_from_reasoning(text)
            if extracted:
                text = extracted

    # 4. Remove **action asterisks** like *thinks* or *checks database*
    text = re.sub(r'\*[^*]{3,80}\*\s*', '', text).strip()

    # 5. If still empty after cleaning, return a safe fallback
    if not text:
        text = "Thank you for your message! Our team will get back to you shortly."

    return text


def _extract_reply_from_reasoning(inner: str) -> str:
    """Extract the actual customer-facing reply from a reasoning dump."""
    # Strategy 1: Look for Draft/Reply/Response patterns with quotes
    draft = re.search(
        r'(?:Draft|Final|Response|Reply|Alternative):\s*["\u201c\u201d\'](.*?)["\u201c\u201d\']',
        inner, re.DOTALL
    )
    if draft:
        return draft.group(1).strip()

    # Strategy 2: Look for quoted sentences (the model often quotes its own reply)
    quotes = re.findall(r'[\u201c"](.*?)[\u201d"]', inner, re.DOTALL)
    # Pick the longest quote that looks like a customer message
    best_quote = ""
    for q in quotes:
        q = q.strip()
        if 20 < len(q) < 500 and not any(kw in q.lower() for kw in ['must not', 'should not', 'let me', 'risky']):
            if len(q) > len(best_quote):
                best_quote = q
    if best_quote:
        return best_quote

    # Strategy 3: Take the last clean non-analysis line
    analysis_keywords = ['must not', 'should not', 'let me', 'i need to', 'checking', 'analyzing',
                         'looking at', 'important:', 'risky', 'better to be', 'wait:', 'but wait',
                         'word count', 'strict', 'alternative:', 'the user', 'my response',
                         'i should', 'i must', 'best approach', 'not assume']
    lines = [l.strip() for l in inner.split('\n') if l.strip() and not l.strip().startswith(('-', '*', '#', '>'))]
    for line in reversed(lines):
        line_lower = line.lower()
        if len(line) < 400 and not any(kw in line_lower for kw in analysis_keywords):
            return line.strip('"\u201c\u201d\' ')

    # Fallback
    return ""


async def generate_ai_reply(ai_settings, business, history, current_message, media_files=None, appt_context="") -> str:
    """Generate an AI reply using the configured provider."""
    if not current_message or not current_message.strip():
        return ""

    if not ai_settings or not ai_settings.api_key:
        logger.warning("[Engine] No AI settings or API key configured — using fallback")
        return "Thank you for your message! We'll get back to you shortly."

    # Build system prompt
    system_prompt = ai_settings.system_prompt or "You are a helpful business assistant. Be professional and concise."

    # Append business info as reference
    if business:
        biz_parts = []
        if business.name: biz_parts.append(f"Business: {business.name}")
        if business.industry: biz_parts.append(f"Industry: {business.industry}")
        if business.services: biz_parts.append(f"Services/Info: {business.services}")
        if business.pricing: biz_parts.append(f"Pricing: {business.pricing}")
        if business.location: biz_parts.append(f"Location: {business.location}")
        if business.working_hours: biz_parts.append(f"Working Hours: {business.working_hours}")
        if business.offers: biz_parts.append(f"Current Offers: {business.offers}")
        if business.faqs: biz_parts.append(f"FAQs: {business.faqs}")
        if biz_parts:
            system_prompt += "\n\n--- Business Reference Data ---\n" + "\n".join(biz_parts)

    # Append media catalog so AI knows what files are available
    if media_files:
        media_lines = []
        for m in media_files:
            desc = f" — {m.description}" if m.description else ""
            media_lines.append(f'[MEDIA:{m.id}] "{m.name}" ({m.file_type}){desc}')
        system_prompt += "\n\n--- Available Media Files ---\n"
        system_prompt += "You can send media files to the customer by including the tag exactly as shown (e.g. [MEDIA:1]) in your reply. Only include a media tag when it is relevant to the conversation.\n"
        system_prompt += "\n".join(media_lines)

    # Append appointment booking context
    if appt_context:
        system_prompt += "\n\n--- Appointment Booking ---\n" + appt_context

    system_prompt += "\n\n--- OUTPUT RULES (MANDATORY) ---\nYou MUST only output the FINAL customer-facing message. Do NOT include internal thoughts, reasoning, monologue, analysis, or drafts. Do NOT wrap your response in parentheses () or <think> tags. Do NOT use asterisk actions like *thinks*. Your entire output goes DIRECTLY to the customer via WhatsApp."

    # Build messages array
    messages = [{"role": "system", "content": system_prompt}]
    for msg in history:
        role = "assistant" if msg.sender_type == "ai" else "user"
        messages.append({"role": role, "content": msg.message_text})

    # Ensure current_message is present at the end of messages for the model to reply to
    if current_message and (not messages or messages[-1]["role"] != "user" or messages[-1]["content"] != current_message):
        messages.append({"role": "user", "content": current_message})

    temp = float(ai_settings.temperature if ai_settings.temperature is not None else 0.7)
    if temp > 1.2 or temp < 0.1:
        temp = 0.7

    max_toks = int(ai_settings.max_tokens or 500)
    if max_toks > 1000 or max_toks < 50:
        max_toks = 500

    provider = ai_settings.provider.lower()

    # Default model fallbacks if model is empty
    model = (ai_settings.model or "").strip()
    if not model:
        model_defaults = {
            "openai": "gpt-4o-mini",
            "gemini": "gemini-1.5-flash",
            "openrouter": "openrouter/free",
        }
        model = model_defaults.get(provider, "gpt-4o-mini")
        logger.warning(f"[Engine] Model was empty — using default: {model}")

    logger.info(f"[Engine] Generating reply via {provider} / {model} (history: {len(history)} msgs, temp={temp}, max_tokens={max_toks})")

    try:
        if provider in ("openai", "openrouter"):
            from openai import AsyncOpenAI
            base_url = "https://openrouter.ai/api/v1" if provider == "openrouter" else None
            client = AsyncOpenAI(api_key=ai_settings.api_key, base_url=base_url)

            try:
                response = await client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=temp,
                    max_tokens=max_toks,
                )
            except Exception as call_err:
                err_str = str(call_err).lower()
                # If OpenRouter reports out of credits (402) or model not found (404), auto-fallback to openrouter/free!
                if provider == "openrouter" and ('402' in err_str or 'credits' in err_str or '404' in err_str):
                    logger.warning(f"[Engine] OpenRouter credit issue ({call_err}) for model '{model}' — auto-falling back to 'openrouter/free'!")
                    response = await client.chat.completions.create(
                        model="openrouter/free",
                        messages=messages,
                        temperature=temp,
                        max_tokens=max_toks,
                    )
                else:
                    raise call_err

            raw_reply = response.choices[0].message.content
            if not raw_reply:
                raw_reply = getattr(response.choices[0].message, 'reasoning', '') or ''
            reply = _clean_ai_reply(raw_reply)
            logger.info(f"[Engine] AI reply generated ({len(reply)} chars)")
            return reply

        elif provider == "anthropic":
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=ai_settings.api_key)
            anthropic_messages = [{"role": m["role"], "content": m["content"]} for m in messages if m["role"] != "system"]
            response = await client.messages.create(
                model=model,
                system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
                messages=anthropic_messages,
                temperature=temp,
                max_tokens=max_toks,
            )
            raw_reply = response.content[0].text if response.content else ""
            reply = _clean_ai_reply(raw_reply)
            logger.info(f"[Engine] AI reply generated ({len(reply)} chars)")
            return reply

        elif provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=ai_settings.api_key)
            gmodel = genai.GenerativeModel(
                model,
                system_instruction=system_prompt,
                generation_config={
                    "temperature": temp,
                    "max_output_tokens": max_toks,
                }
            )
            # Gemini requires history to start with 'user' and alternate 'user' -> 'model'
            # Also history must NOT include the current message (which is passed to send_message)
            gemini_history = []
            hist_messages = history[:-1] if (history and history[-1].message_text == current_message) else history

            for msg in hist_messages:
                role = "model" if msg.sender_type == "ai" else "user"
                # If consecutive messages have the same role, combine them
                if gemini_history and gemini_history[-1]["role"] == role:
                    gemini_history[-1]["parts"][0] += f"\n{msg.message_text}"
                else:
                    gemini_history.append({"role": role, "parts": [msg.message_text]})

            # Gemini history must start with 'user'
            while gemini_history and gemini_history[0]["role"] != "user":
                gemini_history.pop(0)

            # Gemini's generate_content is synchronous — run in thread to avoid blocking event loop
            chat = gmodel.start_chat(history=gemini_history)
            response = await asyncio.to_thread(chat.send_message, current_message)
            reply = _clean_ai_reply(response.text)
            logger.info(f"[Engine] AI reply generated ({len(reply)} chars)")
            return reply

        else:
            logger.warning(f"[Engine] Unknown provider: {provider}")
            return "Thank you for your message! We'll get back to you shortly."

    except Exception as e:
        logger.error(f"[Engine] AI ERROR ({provider}/{model}): {type(e).__name__}: {e}")
        return "Thank you for reaching out! Our team will respond shortly."


async def score_lead(lead, ai_settings, history, db):
    """Universal & Dynamic Lead Qualification Engine (4-Factor Buyer Intent Framework)."""
    if not ai_settings or not ai_settings.api_key:
        return

    # 1. Rule 1: First Interaction Grace Rule (Prevent marking single "Hi/Hello" as Cold)
    customer_msgs = [m for m in history if m.sender_type == "customer"]
    if len(customer_msgs) == 1:
        first_text = (customer_msgs[0].message_text or "").strip().lower()
        greetings = {"hi", "hello", "hey", "namaste", "pranam", "hlo", "hii", "hiii", "good morning", "good evening", "good afternoon", "start", "hy", "hola", "yo"}
        if first_text in greetings or (len(first_text) <= 4 and "?" not in first_text and not any(c.isdigit() for c in first_text)):
            lead.lead_score = max(lead.lead_score or 0, 35)
            if not lead.lead_status or lead.lead_status == "cold":
                lead.lead_status = "new"
            lead.summary = "Just initiated conversation / greeting"
            lead.suggested_action = "Awaiting customer requirements"
            await db.flush()
            logger.info(f"[Engine] Lead {lead.phone_number} kept as 'new' (initial greeting grace)")
            return

    # 2. Rule 2: Check for Confirmed Appointment (Guaranteed HOT Lead)
    has_confirmed_appt = False
    try:
        appt_res = await db.execute(
            select(Appointment).where(
                Appointment.lead_id == lead.id,
                Appointment.status == "confirmed"
            )
        )
        has_confirmed_appt = appt_res.scalars().first() is not None
    except Exception as appt_check_err:
        logger.warning(f"[Engine] Appointment check warning in scoring: {appt_check_err}")

    # 3. Dynamic Business Profile Injection
    biz_res = await db.execute(select(Business).where(Business.id == lead.business_id))
    business = biz_res.scalar_one_or_none()
    biz_name = (business.name or "Business").strip() if business else "Business"
    biz_industry = (business.industry or "").strip() if business else ""
    biz_services = (business.services or "").strip() if business else ""
    biz_location = (business.location or "").strip() if business else ""

    context_header = f"Business: '{biz_name}'"
    if biz_industry:
        context_header += f" | Industry: {biz_industry}"
    if biz_location:
        context_header += f" | Location: {biz_location}"
    if biz_services:
        context_header += f"\nKey Offerings / Services: {biz_services[:300]}"

    conversation_text = "\n".join(
        [f"{'Customer' if m.sender_type == 'customer' else 'AI'}: {m.message_text}" for m in history]
    )

    # Use custom scoring prompt if defined in AI settings, otherwise Universal 4-Factor Framework
    custom_scoring = ai_settings.scoring_prompt.strip() if ai_settings.scoring_prompt else ""

    if custom_scoring:
        scoring_prompt = f"""{custom_scoring}

Business Context:
{context_header}

Return ONLY a valid JSON object with NO extra text or markdown formatting:
{{"score": number (0-100), "label": "hot|warm|cold", "summary": "1 sentence describing customer need", "suggested_action": "1 concrete next step for staff"}}

Conversation:
{conversation_text}"""
    else:
        scoring_prompt = f"""You are an elite sales qualification specialist analyzing a customer conversation for:
{context_header}

Evaluate buyer intent using the Universal 4-Factor Intent Framework:
1. Specific Need: Did the customer ask for a specific service, product, package, or solution?
2. Action & Visit Intent: Did they ask for an appointment, site visit, demo, consultation, timing, or booking?
3. Urgency & Timeline: Are they looking for an immediate / this week / clear timeline vs vague future?
4. Commercial Alignment: Are they receptive to pricing, asking payment methods, or ready to proceed?

Classification Standards:
- HOT (Score 80-100): High intent! Explicitly asked to book, visit, buy, agreed on pricing, has urgent timeline, or booked appointment.
- WARM (Score 50-79): Moderate intent. Comparing options, asked about pricing/services, but has not finalized date/slot yet.
- COLD (Score 0-49): Low intent. Casual browsing, vague answers, out-of-budget, or drop-off.

Return ONLY a valid JSON object with NO markdown or code blocks:
{{
  "score": <integer from 0 to 100>,
  "label": "hot" | "warm" | "cold",
  "summary": "<one crisp sentence describing what this customer wants / their specific inquiry>",
  "suggested_action": "<one actionable step for staff to close or follow up this lead>"
}}

Conversation:
{conversation_text}"""

    try:
        provider = ai_settings.provider.lower()

        # Model fallback
        model = (ai_settings.model or "").strip()
        if not model:
            model_defaults = {
                "openai": "gpt-4o-mini",
                "gemini": "gemini-1.5-flash",
                "openrouter": "openai/gpt-4o-mini",
            }
            model = model_defaults.get(provider, "gpt-4o-mini")

        text = ""
        if provider in ("openai", "openrouter"):
            from openai import AsyncOpenAI
            base_url = "https://openrouter.ai/api/v1" if provider == "openrouter" else None
            client = AsyncOpenAI(api_key=ai_settings.api_key, base_url=base_url)
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": scoring_prompt}],
                temperature=0.3,
                max_tokens=220,
            )
            text = response.choices[0].message.content.strip()

        elif provider == "anthropic":
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=ai_settings.api_key)
            response = await client.messages.create(
                model=model,
                messages=[{"role": "user", "content": scoring_prompt}],
                temperature=0.3,
                max_tokens=220,
            )
            text = response.content[0].text.strip()

        elif provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=ai_settings.api_key)
            gmodel = genai.GenerativeModel(model)
            response = await asyncio.to_thread(gmodel.generate_content, scoring_prompt)
            text = response.text.strip()

        else:
            return

        # Parse JSON score
        if "{" in text:
            raw_json = text[text.index("{"):text.rindex("}") + 1]
            data = json.loads(raw_json)

            score = int(data.get("score", lead.lead_score or 50))
            label = str(data.get("label", lead.lead_status or "warm")).lower()
            summary = str(data.get("summary", "")).strip()[:250]
            action = str(data.get("suggested_action", "")).strip()[:200]

            # Guaranteed appointment booster
            if has_confirmed_appt:
                score = max(score, 95)
                label = "hot"
                if not action or action.lower() in ("none", "null"):
                    action = "Appointment confirmed. Prepare for customer visit/call."

            lead.lead_score = max(0, min(100, score))
            lead.lead_status = label if label in ("hot", "warm", "cold", "spam", "handover") else "warm"
            if summary:
                lead.summary = summary
            if action:
                lead.suggested_action = action

            await db.flush()
            logger.info(f"[Engine] Lead scored for biz {lead.business_id}: {lead.lead_score} ({lead.lead_status}) — Need: {lead.summary[:50]}")

    except Exception as e:
        logger.error(f"[Engine] Scoring error: {type(e).__name__}: {e}")
