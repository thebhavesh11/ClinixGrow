"""Client management router — create, list, update, delete clients with auto-seeding."""

import logging
import os
import secrets
import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from sqlalchemy.orm import selectinload
from database import get_db
from models import (
    Business, AISetting, WorkingHours, VoiceSettings,
    Lead, Conversation, Message, Appointment, CallLog, BusinessMedia,
)
from schemas import BusinessCreate, BusinessUpdate, BusinessResponse
from typing import List, Optional
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clients", tags=["Clients"])


class ClientStats(BaseModel):
    id: int
    name: str
    industry: str = ""
    location: str = ""
    portal_token: Optional[str] = None
    has_portal_pin: bool = False
    logo_url: Optional[str] = ""
    created_at: Optional[str] = None
    leads_count: int = 0
    conversations_count: int = 0
    appointments_count: int = 0
    messages_count: int = 0

    class Config:
        from_attributes = True


class ClientCreate(BaseModel):
    name: str
    industry: str = ""
    services: str = ""
    pricing: str = ""
    faqs: str = ""
    location: str = ""
    offers: str = ""
    working_hours: str = ""
    portal_pin: Optional[str] = None
    logo_url: Optional[str] = ""


class PortalSettingsUpdate(BaseModel):
    portal_pin: Optional[str] = None
    regenerate_token: bool = False
    logo_url: Optional[str] = None


# ══════════════════════════════════════════════════════════════════════
#  CLIENT CRUD
# ══════════════════════════════════════════════════════════════════════

@router.get("", response_model=List[ClientStats])
async def list_clients(db: AsyncSession = Depends(get_db)):
    """List all clients/businesses with stats."""
    result = await db.execute(select(Business).order_by(Business.created_at.asc()))
    businesses = result.scalars().all()

    clients = []
    for biz in businesses:
        # Get counts
        leads_r = await db.execute(select(func.count(Lead.id)).where(Lead.business_id == biz.id))
        convos_r = await db.execute(select(func.count(Conversation.id)).where(Conversation.business_id == biz.id))
        appts_r = await db.execute(select(func.count(Appointment.id)).where(Appointment.business_id == biz.id))
        msgs_r = await db.execute(
            select(func.count(Message.id)).join(Conversation).where(Conversation.business_id == biz.id)
        )

        clients.append(ClientStats(
            id=biz.id,
            name=biz.name,
            industry=biz.industry or "",
            location=biz.location or "",
            portal_token=biz.portal_token,
            has_portal_pin=bool(biz.portal_pin and biz.portal_pin.strip()),
            logo_url=biz.logo_url or "",
            created_at=biz.created_at.isoformat() if biz.created_at else None,
            leads_count=leads_r.scalar() or 0,
            conversations_count=convos_r.scalar() or 0,
            appointments_count=appts_r.scalar() or 0,
            messages_count=msgs_r.scalar() or 0,
        ))

    return clients


@router.post("", response_model=ClientStats)
async def create_client(data: ClientCreate, db: AsyncSession = Depends(get_db)):
    """Create a new client with auto-seeded settings."""
    # Create business
    biz = Business(
        name=data.name,
        industry=data.industry,
        services=data.services,
        pricing=data.pricing,
        faqs=data.faqs,
        location=data.location,
        offers=data.offers,
        working_hours=data.working_hours,
        portal_token=f"portal_{secrets.token_urlsafe(16)}",
        portal_pin=data.portal_pin.strip() if data.portal_pin else None,
        logo_url=data.logo_url or "",
    )
    db.add(biz)
    await db.flush()
    await db.refresh(biz)

    bid = biz.id

    # Auto-seed AI Settings
    db.add(AISetting(
        business_id=bid,
        provider="openai",
        model="gpt-4o-mini",
        system_prompt=f"You are a helpful AI assistant for {data.name}.",
    ))

    # Auto-seed Working Hours (Mon-Fri 9-6, break 1-2, 30min slots)
    for day in range(7):
        db.add(WorkingHours(
            business_id=bid,
            day_of_week=day,
            is_open=1 if day < 5 else 0,
            start_time="09:00",
            end_time="18:00",
            break_start="13:00",
            break_end="14:00",
            slot_duration=30,
        ))

    # Auto-seed Voice Settings
    db.add(VoiceSettings(
        business_id=bid,
        webhook_secret=secrets.token_hex(16),
    ))

    await db.flush()
    logger.info(f"[Clients] Created client: {data.name!r} (id={bid}) with seeded settings")

    return ClientStats(
        id=bid,
        name=biz.name,
        industry=biz.industry or "",
        location=biz.location or "",
        portal_token=biz.portal_token,
        has_portal_pin=bool(biz.portal_pin),
        logo_url=biz.logo_url or "",
        created_at=biz.created_at.isoformat() if biz.created_at else None,
        leads_count=0, conversations_count=0, appointments_count=0, messages_count=0,
    )


@router.post("/{client_id}/portal-settings")
async def update_portal_settings(client_id: int, data: PortalSettingsUpdate, db: AsyncSession = Depends(get_db)):
    """Update portal PIN, regenerate secret token, or update logo."""
    result = await db.execute(select(Business).where(Business.id == client_id))
    biz = result.scalar_one_or_none()
    if not biz:
        raise HTTPException(404, "Client not found")

    if data.regenerate_token:
        biz.portal_token = f"portal_{secrets.token_urlsafe(16)}"
        logger.info(f"[Clients] Regenerated portal token for client {client_id}")

    if data.portal_pin is not None:
        biz.portal_pin = data.portal_pin.strip() if data.portal_pin.strip() else None

    if data.logo_url is not None:
        biz.logo_url = data.logo_url.strip()

    await db.flush()
    await db.refresh(biz)
    return {
        "success": True,
        "portal_token": biz.portal_token,
        "has_portal_pin": bool(biz.portal_pin),
        "logo_url": biz.logo_url,
    }


@router.get("/{client_id}", response_model=BusinessResponse)
async def get_client(client_id: int, db: AsyncSession = Depends(get_db)):
    """Get a specific client's full business profile."""
    result = await db.execute(select(Business).where(Business.id == client_id))
    biz = result.scalar_one_or_none()
    if not biz:
        raise HTTPException(404, "Client not found")
    return biz


@router.put("/{client_id}", response_model=BusinessResponse)
async def update_client(client_id: int, data: BusinessUpdate, db: AsyncSession = Depends(get_db)):
    """Update a client's business profile."""
    result = await db.execute(select(Business).where(Business.id == client_id))
    biz = result.scalar_one_or_none()
    if not biz:
        raise HTTPException(404, "Client not found")

    for key, value in data.model_dump().items():
        setattr(biz, key, value)

    await db.flush()
    await db.refresh(biz)
    logger.info(f"[Clients] Updated client: {biz.name!r} (id={client_id})")
    return biz


@router.delete("/{client_id}")
async def delete_client(client_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a client and ALL their related data (cascade)."""
    result = await db.execute(select(Business).where(Business.id == client_id))
    biz = result.scalar_one_or_none()
    if not biz:
        raise HTTPException(404, "Client not found")

    name = biz.name

    # Delete in dependency order to avoid FK constraint errors
    # 1. Messages (depend on conversations)
    conv_ids_result = await db.execute(
        select(Conversation.id).where(Conversation.business_id == client_id)
    )
    conv_ids = [r[0] for r in conv_ids_result.fetchall()]
    if conv_ids:
        await db.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))

    # 2. Conversations
    await db.execute(delete(Conversation).where(Conversation.business_id == client_id))

    # 3. Appointments
    await db.execute(delete(Appointment).where(Appointment.business_id == client_id))

    # 4. Call Logs
    await db.execute(delete(CallLog).where(CallLog.business_id == client_id))

    # 5. Business Media
    await db.execute(delete(BusinessMedia).where(BusinessMedia.business_id == client_id))

    # 6. Leads
    await db.execute(delete(Lead).where(Lead.business_id == client_id))

    # 7. Settings
    await db.execute(delete(AISetting).where(AISetting.business_id == client_id))
    await db.execute(delete(WorkingHours).where(WorkingHours.business_id == client_id))
    await db.execute(delete(VoiceSettings).where(VoiceSettings.business_id == client_id))

    # 8. Business itself
    await db.execute(delete(Business).where(Business.id == client_id))
    await db.flush()

    # 9. Clean up WhatsApp session on bridge
    bridge_url = os.getenv("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3001")
    try:
        async with httpx.AsyncClient(timeout=1.5) as http_client:
            await http_client.delete(f"{bridge_url}/session/{client_id}")
            logger.info(f"[Clients] Deleted WhatsApp session on bridge for client {client_id}")
    except Exception as bridge_err:
        logger.warning(f"[Clients] Could not notify bridge of deleted client {client_id}: {bridge_err}")

    logger.info(f"[Clients] Deleted client: {name!r} (id={client_id}) with all related data")
    return {"success": True, "message": f"Client '{name}' and all related data deleted"}
