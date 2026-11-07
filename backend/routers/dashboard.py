"""Dashboard analytics router."""

import logging
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from datetime import datetime, timedelta
from database import get_db
from models import Lead, Message, Conversation, Appointment, CallLog
from schemas import DashboardResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"])


@router.get("", response_model=DashboardResponse)
async def get_dashboard(business_id: int = 1, db: AsyncSession = Depends(get_db)):
    """Get dashboard analytics scoped to a business. Returns zeroed response on error."""
    try:
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        bid = business_id

        # Total messages today (via conversations belonging to this business)
        result = await db.execute(
            select(func.count(Message.id))
            .join(Conversation)
            .where(Conversation.business_id == bid, Message.created_at >= today_start)
        )
        total_messages_today = result.scalar() or 0

        # Total leads today
        result = await db.execute(
            select(func.count(Lead.id)).where(Lead.business_id == bid, Lead.created_at >= today_start)
        )
        total_leads_today = result.scalar() or 0

        # Lead status breakdown
        result = await db.execute(
            select(func.count(Lead.id)).where(Lead.business_id == bid, Lead.lead_status == "hot")
        )
        hot_leads = result.scalar() or 0

        result = await db.execute(
            select(func.count(Lead.id)).where(Lead.business_id == bid, Lead.lead_status == "warm")
        )
        warm_leads = result.scalar() or 0

        result = await db.execute(
            select(func.count(Lead.id)).where(Lead.business_id == bid, Lead.lead_status == "cold")
        )
        cold_leads = result.scalar() or 0

        result = await db.execute(
            select(func.count(Lead.id)).where(Lead.business_id == bid, Lead.lead_status == "spam")
        )
        spam_leads = result.scalar() or 0

        # Active conversations (messages in last 24h)
        yesterday = datetime.utcnow() - timedelta(hours=24)
        result = await db.execute(
            select(func.count(func.distinct(Message.conversation_id)))
            .join(Conversation)
            .where(Conversation.business_id == bid, Message.created_at >= yesterday)
        )
        active_conversations = result.scalar() or 0

        # Total leads
        result = await db.execute(select(func.count(Lead.id)).where(Lead.business_id == bid))
        total_leads = result.scalar() or 0

        # Total conversations
        result = await db.execute(select(func.count(Conversation.id)).where(Conversation.business_id == bid))
        total_conversations = result.scalar() or 0

        return DashboardResponse(
            total_messages_today=total_messages_today,
            total_leads_today=total_leads_today,
            hot_leads=hot_leads,
            warm_leads=warm_leads,
            cold_leads=cold_leads,
            spam_leads=spam_leads,
            active_conversations=active_conversations,
            total_leads=total_leads,
            total_conversations=total_conversations,
            appointments_today=await _count_appointments_today(db, today_start, bid),
            upcoming_appointments=await _count_upcoming_appointments(db, bid),
            calls_today=await _count_calls_today(db, today_start, bid),
            total_call_minutes=await _total_call_minutes_today(db, today_start, bid),
        )
    except Exception as e:
        logger.error(f"[Dashboard] Error fetching analytics: {type(e).__name__}: {e}")
        return DashboardResponse()


async def _count_appointments_today(db, today_start, bid):
    today_str = today_start.strftime("%Y-%m-%d")
    result = await db.execute(
        select(func.count(Appointment.id)).where(
            Appointment.business_id == bid,
            Appointment.date == today_str,
            Appointment.status == "confirmed",
        )
    )
    return result.scalar() or 0


async def _count_upcoming_appointments(db, bid):
    today_str = datetime.utcnow().strftime("%Y-%m-%d")
    week_later = (datetime.utcnow() + timedelta(days=7)).strftime("%Y-%m-%d")
    result = await db.execute(
        select(func.count(Appointment.id)).where(
            Appointment.business_id == bid,
            Appointment.date >= today_str,
            Appointment.date <= week_later,
            Appointment.status == "confirmed",
        )
    )
    return result.scalar() or 0


async def _count_calls_today(db, today_start, bid):
    result = await db.execute(
        select(func.count(CallLog.id)).where(
            CallLog.business_id == bid,
            CallLog.created_at >= today_start,
        )
    )
    return result.scalar() or 0


async def _total_call_minutes_today(db, today_start, bid):
    result = await db.execute(
        select(func.sum(CallLog.duration_seconds)).where(
            CallLog.business_id == bid,
            CallLog.created_at >= today_start,
        )
    )
    total_secs = result.scalar() or 0
    return total_secs // 60


async def calculate_date_analytics(bid: int, target_date_str: Optional[str], tz_offset: int, db: AsyncSession) -> dict:
    """Calculate date-specific WhatsApp message, inquiry, and contact analytics."""
    try:
        now_local = datetime.utcnow() + timedelta(minutes=tz_offset)
        today_str = now_local.strftime("%Y-%m-%d")
        yesterday_str = (now_local - timedelta(days=1)).strftime("%Y-%m-%d")

        if not target_date_str or not target_date_str.strip():
            target_date_str = today_str

        try:
            target_dt = datetime.strptime(target_date_str, "%Y-%m-%d")
        except Exception:
            target_date_str = today_str
            target_dt = datetime.strptime(target_date_str, "%Y-%m-%d")

        start_utc = target_dt - timedelta(minutes=tz_offset)
        end_utc = start_utc + timedelta(days=1) - timedelta(microseconds=1)

        # 1. Fetch all messages in the target date range for this business
        msgs_query = (
            select(Message, Conversation.lead_id)
            .join(Conversation, Message.conversation_id == Conversation.id)
            .where(
                Conversation.business_id == bid,
                Message.created_at >= start_utc,
                Message.created_at <= end_utc
            )
            .order_by(Message.created_at.desc())
        )
        res = await db.execute(msgs_query)
        rows = res.all()

        total_messages = len(rows)
        incoming_count = sum(1 for m, _ in rows if m.sender_type == "customer")
        ai_replies_count = sum(1 for m, _ in rows if m.sender_type == "ai")
        human_replies_count = sum(1 for m, _ in rows if m.sender_type == "human")
        active_conversation_ids = {m.conversation_id for m, _ in rows}

        # 2. Analyze active leads on this date
        lead_msg_counts = {}
        lead_last_msg = {}
        lead_last_time = {}
        active_lead_ids = set()

        for m, lid in rows:
            if not lid:
                continue
            active_lead_ids.add(lid)
            lead_msg_counts[lid] = lead_msg_counts.get(lid, 0) + 1
            if lid not in lead_last_msg:
                raw_text = (m.message_text or "").strip()
                if raw_text.startswith('/9j/') or raw_text.startswith('data:image') or (len(raw_text) > 150 and ' ' not in raw_text):
                    clean_preview = '📷 [Photo]'
                else:
                    clean_preview = raw_text[:80]
                lead_last_msg[lid] = clean_preview
                lead_last_time[lid] = (m.created_at + timedelta(minutes=tz_offset)).strftime("%I:%M %p")

        contacts_list = []
        new_contacts_count = 0
        returning_contacts_count = 0
        saved_name_count = 0
        unsaved_count = 0

        if active_lead_ids:
            leads_res = await db.execute(select(Lead).where(Lead.id.in_(active_lead_ids)))
            leads = leads_res.scalars().all()
            for l in leads:
                is_new = (l.created_at >= start_utc and l.created_at <= end_utc)
                if is_new:
                    new_contacts_count += 1
                else:
                    returning_contacts_count += 1

                clean_name = (l.name or "").strip()
                is_saved_name = bool(
                    clean_name 
                    and clean_name.lower() != "unknown" 
                    and clean_name != l.phone_number 
                    and not clean_name.startswith("+")
                )
                if is_saved_name:
                    saved_name_count += 1
                else:
                    unsaved_count += 1

                contacts_list.append({
                    "lead_id": l.id,
                    "name": clean_name if clean_name and clean_name.lower() != "unknown" else l.phone_number,
                    "phone_number": l.phone_number,
                    "is_new": is_new,
                    "is_saved_name": is_saved_name,
                    "messages_count": lead_msg_counts.get(l.id, 0),
                    "lead_status": l.lead_status or "new",
                    "lead_score": l.lead_score or 0,
                    "last_message": lead_last_msg.get(l.id, ""),
                    "last_time": lead_last_time.get(l.id, ""),
                })

            contacts_list.sort(key=lambda x: x["messages_count"], reverse=True)

        # 3. Appointments booked on this date
        appts_res = await db.execute(
            select(func.count(Appointment.id)).where(
                Appointment.business_id == bid,
                Appointment.date == target_date_str
            )
        )
        appointments_count = appts_res.scalar() or 0

        # 4. Hourly distribution in client local hours (00 to 23)
        hourly = [{"hour": f"{h:02d}:00", "incoming": 0, "outgoing": 0, "total": 0} for h in range(24)]
        for m, _ in rows:
            local_dt = m.created_at + timedelta(minutes=tz_offset)
            h = local_dt.hour
            if 0 <= h < 24:
                if m.sender_type == "customer":
                    hourly[h]["incoming"] += 1
                else:
                    hourly[h]["outgoing"] += 1
                hourly[h]["total"] += 1

        # 5. Quick counts for presets (Today & Yesterday)
        today_dt = datetime.strptime(today_str, "%Y-%m-%d")
        t_start_utc = today_dt - timedelta(minutes=tz_offset)
        t_end_utc = t_start_utc + timedelta(days=1) - timedelta(microseconds=1)

        y_dt = datetime.strptime(yesterday_str, "%Y-%m-%d")
        y_start_utc = y_dt - timedelta(minutes=tz_offset)
        y_end_utc = y_start_utc + timedelta(days=1) - timedelta(microseconds=1)

        t_res = await db.execute(
            select(func.count(Message.id)).join(Conversation).where(
                Conversation.business_id == bid,
                Message.created_at >= t_start_utc,
                Message.created_at <= t_end_utc
            )
        )
        today_messages_count = t_res.scalar() or 0

        y_res = await db.execute(
            select(func.count(Message.id)).join(Conversation).where(
                Conversation.business_id == bid,
                Message.created_at >= y_start_utc,
                Message.created_at <= y_end_utc
            )
        )
        yesterday_messages_count = y_res.scalar() or 0

        if target_date_str == today_str:
            display_label = f"Today, {target_dt.strftime('%d %b %Y')}"
        elif target_date_str == yesterday_str:
            display_label = f"Yesterday, {target_dt.strftime('%d %b %Y')}"
        else:
            display_label = target_dt.strftime("%A, %d %b %Y")

        return {
            "date": target_date_str,
            "display_label": display_label,
            "is_today": (target_date_str == today_str),
            "is_yesterday": (target_date_str == yesterday_str),
            "summary": {
                "total_messages": total_messages,
                "incoming_messages": incoming_count,
                "ai_replies": ai_replies_count,
                "human_replies": human_replies_count,
                "active_conversations": len(active_conversation_ids),
                "active_contacts": len(contacts_list),
                "new_numbers": new_contacts_count,
                "returning_contacts": returning_contacts_count,
                "saved_contacts": saved_name_count,
                "unsaved_contacts": unsaved_count,
                "appointments_count": appointments_count,
            },
            "presets": {
                "today_date": today_str,
                "yesterday_date": yesterday_str,
                "today_messages": today_messages_count,
                "yesterday_messages": yesterday_messages_count,
            },
            "hourly_distribution": hourly,
            "contacts": contacts_list,
        }
    except Exception as e:
        logger.error(f"[DateAnalytics] Error calculating date stats: {type(e).__name__}: {e}")
        return {
            "date": target_date_str or "",
            "display_label": target_date_str or "",
            "is_today": True,
            "is_yesterday": False,
            "summary": {
                "total_messages": 0,
                "incoming_messages": 0,
                "ai_replies": 0,
                "human_replies": 0,
                "active_conversations": 0,
                "active_contacts": 0,
                "new_numbers": 0,
                "returning_contacts": 0,
                "saved_contacts": 0,
                "unsaved_contacts": 0,
                "appointments_count": 0,
            },
            "presets": {
                "today_date": "",
                "yesterday_date": "",
                "today_messages": 0,
                "yesterday_messages": 0,
            },
            "hourly_distribution": [],
            "contacts": [],
        }


@router.get("/date-stats")
async def get_dashboard_date_stats(
    business_id: int = 1,
    date: Optional[str] = Query(None, description="Date in YYYY-MM-DD format"),
    tz_offset: int = Query(330, description="Timezone offset in minutes (default 330 for IST)"),
    db: AsyncSession = Depends(get_db)
):
    """Get rich date-specific WhatsApp message and contact analytics for admin dashboard."""
    return await calculate_date_analytics(bid=business_id, target_date_str=date, tz_offset=tz_offset, db=db)
