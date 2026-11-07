"""Leads router."""

import io
import csv
import logging
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Lead, Conversation, Message, Business
from schemas import LeadResponse, LeadCreate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/leads", tags=["Leads"])


@router.get("", response_model=List[LeadResponse])
async def list_leads(business_id: int = 1, db: AsyncSession = Depends(get_db)):
    """List all leads for a business, ordered by most recent first."""
    result = await db.execute(
        select(Lead).where(Lead.business_id == business_id).order_by(Lead.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=LeadResponse)
async def create_lead(payload: LeadCreate, db: AsyncSession = Depends(get_db)):
    """Create or manually add a lead in admin."""
    phone = payload.phone_number.strip()
    if not phone:
        raise HTTPException(status_code=400, detail="Phone number is required")

    phone_clean = "".join(c for c in phone if c.isdigit() or c == "+")
    biz_id = payload.business_id or 1

    existing = await db.execute(
        select(Lead).where(Lead.business_id == biz_id, Lead.phone_number == phone_clean)
    )
    lead = existing.scalar_one_or_none()
    if lead:
        if payload.name and payload.name != "Unknown":
            lead.name = payload.name
        if payload.lead_status:
            lead.lead_status = payload.lead_status
        if payload.lead_score:
            lead.lead_score = payload.lead_score
        if payload.summary:
            lead.summary = payload.summary
        if payload.suggested_action:
            lead.suggested_action = payload.suggested_action
        await db.flush()
        return lead

    new_lead = Lead(
        phone_number=phone_clean,
        name=payload.name or "Unknown",
        business_id=biz_id,
        lead_status=payload.lead_status or "new",
        lead_score=payload.lead_score or 50,
        summary=payload.summary or "Manually added lead",
        suggested_action=payload.suggested_action or "Follow up with customer",
    )
    db.add(new_lead)
    await db.flush()
    await db.refresh(new_lead)

    conv = Conversation(lead_id=new_lead.id, business_id=biz_id)
    db.add(conv)
    await db.flush()

    return new_lead


@router.get("/export")
async def export_admin_leads_csv(
    business_id: int = 1,
    status: Optional[str] = Query(None),
    date_preset: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    tz_offset: int = Query(330),
    db: AsyncSession = Depends(get_db)
):
    """Export leads CSV for admin dashboard (Google Sheets & Excel compatible)."""
    biz_res = await db.execute(select(Business).where(Business.id == business_id))
    biz = biz_res.scalar_one_or_none()
    biz_name = biz.name if biz else "Business"

    query = select(Lead).where(Lead.business_id == business_id)

    if status and status.lower() != "all":
        query = query.where(Lead.lead_status == status.lower())

    now_local = datetime.utcnow() + timedelta(minutes=tz_offset)
    today_start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)

    if date_preset == "today":
        start_utc = today_start_local - timedelta(minutes=tz_offset)
        query = query.where(Lead.created_at >= start_utc)
    elif date_preset == "yesterday":
        y_start_local = today_start_local - timedelta(days=1)
        start_utc = y_start_local - timedelta(minutes=tz_offset)
        end_utc = today_start_local - timedelta(minutes=tz_offset)
        query = query.where(Lead.created_at >= start_utc, Lead.created_at < end_utc)
    elif date_preset == "week":
        start_local = today_start_local - timedelta(days=7)
        start_utc = start_local - timedelta(minutes=tz_offset)
        query = query.where(Lead.created_at >= start_utc)
    elif date_preset == "month":
        start_local = today_start_local - timedelta(days=30)
        start_utc = start_local - timedelta(minutes=tz_offset)
        query = query.where(Lead.created_at >= start_utc)
    elif date_preset == "custom" and start_date:
        try:
            s_dt = datetime.strptime(start_date.strip(), "%Y-%m-%d")
            s_utc = s_dt - timedelta(minutes=tz_offset)
            query = query.where(Lead.created_at >= s_utc)
            if end_date:
                e_dt = datetime.strptime(end_date.strip(), "%Y-%m-%d") + timedelta(days=1)
                e_utc = e_dt - timedelta(minutes=tz_offset)
                query = query.where(Lead.created_at < e_utc)
        except Exception:
            pass

    query = query.order_by(Lead.created_at.desc())
    result = await db.execute(query)
    leads = result.scalars().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Lead ID",
        "Full Name",
        "Phone Number",
        "Status",
        "Intent Score",
        "Customer Need (Summary)",
        "Next Best Action",
        "Latest Message",
        "Date Captured",
    ])

    for l in leads:
        last_m_r = await db.execute(
            select(Message.message_text)
            .join(Conversation, Message.conversation_id == Conversation.id)
            .where(Conversation.lead_id == l.id)
            .order_by(Message.created_at.desc())
            .limit(1)
        )
        last_m_text = (last_m_r.scalar_one_or_none() or "").strip()
        if last_m_text.startswith('/9j/') or last_m_text.startswith('data:image'):
            last_m_text = '[Photo]'

        local_created = (l.created_at + timedelta(minutes=tz_offset)).strftime("%Y-%m-%d %I:%M %p") if l.created_at else ""

        writer.writerow([
            l.id,
            l.name or "Unknown",
            l.phone_number,
            (l.lead_status or "new").upper(),
            l.lead_score or 0,
            getattr(l, "summary", "") or "",
            getattr(l, "suggested_action", "") or "",
            last_m_text[:150],
            local_created,
        ])

    csv_data = "\ufeff" + output.getvalue()
    clean_biz_name = "".join(c for c in biz_name if c.isalnum() or c in (" ", "_", "-")).strip().replace(" ", "_")
    status_suffix = f"_{status.upper()}" if status and status.lower() != "all" else ""
    filename = f"{clean_biz_name}_Leads{status_suffix}_{datetime.utcnow().strftime('%Y%m%d')}.csv"

    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": "text/csv; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
        }
    )


@router.get("/{lead_id}", response_model=LeadResponse)
async def get_lead(lead_id: int, db: AsyncSession = Depends(get_db)):
    """Get a specific lead by ID."""
    result = await db.execute(select(Lead).where(Lead.id == lead_id))
    lead = result.scalar_one_or_none()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return lead
