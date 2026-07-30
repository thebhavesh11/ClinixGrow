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
from sqlalchemy import select, func
from models import Lead, Conversation, Message, AISetting, Business, BusinessMedia, Appointment, WorkingHours

logger = logging.getLogger(__name__)

BRIDGE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://localhost:3001")
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")

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


async def process_incoming_message(
    phone: str, message: str, name: str, business_id: int, db: AsyncSession
) -> dict:
    """Process an incoming WhatsApp message end-to-end (sequential per phone)."""
    lock = _get_phone_lock(phone)
    async with lock:
        return await _process_message_inner(phone, message, name, business_id, db)


async def _process_message_inner(
    phone: str, message: str, name: str, business_id: int, db: AsyncSession
) -> dict:
    """Internal message processing — runs under per-phone lock."""

    # 1. Find or create lead
    result = await db.execute(select(Lead).where(Lead.phone_number == phone))
    lead = result.scalar_one_or_none()
    if not lead:
        lead = Lead(phone_number=phone, name=name or "Unknown", business_id=business_id)
        db.add(lead)
        await db.flush()
        await db.refresh(lead)
        logger.info(f"[Engine] Created new lead: {lead.name} ({lead.phone_number})")

    # 1b. Check if lead is handed over — AI should not reply
    if lead.lead_status == 'handover':
        logger.info(f"[Engine] Lead {lead.phone_number} is handed over — skipping AI reply")
        # Still save the incoming message
        result = await db.execute(
            select(Conversation).where(
                Conversation.lead_id == lead.id,
                Conversation.business_id == business_id,
            )
        )
        conv = result.scalar_one_or_none()
        if conv:
            db.add(Message(conversation_id=conv.id, sender_type="customer", message_text=message))
            await db.flush()
        return {"reply": None, "lead_id": lead.id, "handover": True}

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

    # 3. Save incoming message
    customer_msg = Message(
        conversation_id=conv.id,
        sender_type="customer",
        message_text=message,
    )
    db.add(customer_msg)
    await db.flush()

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

    # 6. Generate AI reply
    # 6a. Build appointment context for AI
    appt_context = await _build_appointment_context(db, business_id, lead.id)
    ai_reply = await generate_ai_reply(ai_settings, business, history, message, media_files, appt_context)

    # 7. Parse [MEDIA:ID] tags and send media files
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
                    if wa_mode == "cloud_api":
                        from routers.whatsapp import send_cloud_api_media
                        await send_cloud_api_media(
                            phone=phone,
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
                                    "phone": phone,
                                    "mediaUrl": f"{BACKEND_URL}/api/media/file/{m.id}",
                                    "filename": m.original_filename,
                                    "caption": m.name,
                                },
                            )
                    logger.info(f"[Engine] Sent media '{m.name}' to {phone} via {wa_mode}")
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
    if delay > 0:
        # Typing indicator only works in QR mode (Cloud API doesn't support it)
        if show_typing and wa_mode == "qr":
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    await client.post(f"{BRIDGE_URL}/typing", json={"phone": phone})
                logger.info(f"[Engine] Typing indicator sent to {phone}")
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
                        json={"phone": phone, "message": clean_reply},
                    )
                logger.info(f"[Engine] Replied to {phone} via QR bridge: {clean_reply[:50]}...")
        except httpx.TimeoutException:
            logger.error(f"[Engine] Reply send timed out for {phone}")
        except Exception as e:
            logger.error(f"[Engine] Failed to send reply: {type(e).__name__}: {e}")

    # 10. Score lead (fire-and-forget — errors don't affect the reply)
    try:
        await score_lead(lead, ai_settings, history, db)
    except Exception as e:
        logger.error(f"[Engine] Lead scoring failed (non-critical): {type(e).__name__}: {e}")

    return {"reply": clean_reply, "lead_id": lead.id}


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
    text = raw.strip()
    if not text:
        return text

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
                         'word count', 'draft:', 'alternative:', 'best approach:']
    lines = text.split('\n')
    if len(lines) > 5:
        first_3 = '\n'.join(lines[:3]).lower()
        if any(marker in first_3 for marker in reasoning_markers):
            # Looks like reasoning dump — try to extract actual reply
            text = _extract_reply_from_reasoning(text)

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

    provider = ai_settings.provider.lower()

    # Default model fallbacks if model is empty
    model = (ai_settings.model or "").strip()
    if not model:
        model_defaults = {
            "openai": "gpt-4o-mini",
            "gemini": "gemini-1.5-flash",
            "openrouter": "openai/gpt-4o-mini",
        }
        model = model_defaults.get(provider, "gpt-4o-mini")
        logger.warning(f"[Engine] Model was empty — using default: {model}")

    logger.info(f"[Engine] Generating reply via {provider} / {model} (history: {len(history)} msgs)")

    try:
        if provider in ("openai", "openrouter"):
            from openai import AsyncOpenAI
            base_url = "https://openrouter.ai/api/v1" if provider == "openrouter" else None
            client = AsyncOpenAI(api_key=ai_settings.api_key, base_url=base_url)
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=ai_settings.temperature,
                max_tokens=ai_settings.max_tokens,
            )
            reply = response.choices[0].message.content.strip()
            reply = _clean_ai_reply(reply)
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
                temperature=ai_settings.temperature,
                max_tokens=ai_settings.max_tokens,
            )
            reply = response.content[0].text.strip()
            reply = _clean_ai_reply(reply)
            logger.info(f"[Engine] AI reply generated ({len(reply)} chars)")
            return reply

        elif provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=ai_settings.api_key)
            gmodel = genai.GenerativeModel(
                model,
                system_instruction=system_prompt,
            )
            chat_history = []
            for msg in history:
                role = "model" if msg.sender_type == "ai" else "user"
                chat_history.append({"role": role, "parts": [msg.message_text]})

            # Gemini's generate_content is synchronous — run in thread to avoid blocking event loop
            chat = gmodel.start_chat(history=chat_history)
            response = await asyncio.to_thread(chat.send_message, current_message)
            reply = response.text.strip()
            reply = _clean_ai_reply(reply)
            logger.info(f"[Engine] AI reply generated ({len(reply)} chars)")
            return reply

        else:
            logger.warning(f"[Engine] Unknown provider: {provider}")
            return "Thank you for your message! We'll get back to you shortly."

    except Exception as e:
        logger.error(f"[Engine] AI ERROR ({provider}/{model}): {type(e).__name__}: {e}")
        return "Thank you for reaching out! Our team will respond shortly."


async def score_lead(lead, ai_settings, history, db):
    """Score a lead based on conversation history."""
    if not ai_settings or not ai_settings.api_key:
        return

    conversation_text = "\n".join(
        [f"{'Customer' if m.sender_type == 'customer' else 'AI'}: {m.message_text}" for m in history]
    )

    # Use the custom scoring prompt from settings, or fall back to default
    custom_scoring = ai_settings.scoring_prompt.strip() if ai_settings.scoring_prompt else ""

    if custom_scoring:
        scoring_prompt = f"""{custom_scoring}

Return ONLY a JSON object: {{"score": number, "label": "hot|warm|cold"}}

Conversation:
{conversation_text}"""
    else:
        scoring_prompt = f"""Analyze this conversation and score the lead from 0-100.
Return ONLY a JSON object: {{"score": number, "label": "hot|warm|cold"}}
- HOT (80-100): Ready to buy/visit, has budget clarity, urgency
- WARM (50-79): Interested but needs nurturing, comparing options
- COLD (0-49): Just browsing, no budget mentioned, vague interest

Conversation:
{conversation_text}"""

    try:
        provider = ai_settings.provider.lower()

        # Model fallback (same as generate_ai_reply)
        model = (ai_settings.model or "").strip()
        if not model:
            model_defaults = {
                "openai": "gpt-4o-mini",
                "gemini": "gemini-1.5-flash",
                "openrouter": "openai/gpt-4o-mini",
            }
            model = model_defaults.get(provider, "gpt-4o-mini")

        if provider in ("openai", "openrouter"):
            from openai import AsyncOpenAI
            base_url = "https://openrouter.ai/api/v1" if provider == "openrouter" else None
            client = AsyncOpenAI(api_key=ai_settings.api_key, base_url=base_url)
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": scoring_prompt}],
                temperature=0.3,
                max_tokens=100,
            )
            text = response.choices[0].message.content.strip()

        elif provider == "anthropic":
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=ai_settings.api_key)
            response = await client.messages.create(
                model=model,
                messages=[{"role": "user", "content": scoring_prompt}],
                temperature=0.3,
                max_tokens=100,
            )
            text = response.content[0].text.strip()

        elif provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=ai_settings.api_key)
            gmodel = genai.GenerativeModel(model)
            # Run blocking Gemini call in thread to avoid blocking event loop
            response = await asyncio.to_thread(gmodel.generate_content, scoring_prompt)
            text = response.text.strip()

        else:
            return

        # Parse JSON score
        if "{" in text:
            data = json.loads(text[text.index("{"):text.rindex("}") + 1])
            lead.lead_score = data.get("score", lead.lead_score)
            lead.lead_status = data.get("label", lead.lead_status)
            await db.flush()
            logger.info(f"[Engine] Lead scored: {lead.lead_score} ({lead.lead_status})")

    except Exception as e:
        logger.error(f"[Engine] Scoring error: {type(e).__name__}: {e}")
