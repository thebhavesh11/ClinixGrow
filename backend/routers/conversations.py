"""Conversations and Messages router."""

import os
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from database import get_db
from models import Conversation, Message, Lead, AISetting
from schemas import ConversationResponse, MessageResponse
from pydantic import BaseModel
from typing import List, Optional
import httpx

logger = logging.getLogger(__name__)

BRIDGE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3001")

router = APIRouter(prefix="/api/conversations", tags=["Conversations"])


class ManualReplyRequest(BaseModel):
    message: str


class LeadStatusUpdate(BaseModel):
    status: str  # e.g. "handover", "hot", "warm", "cold", "new"


@router.get("", response_model=List[ConversationResponse])
async def list_conversations(business_id: int = 1, db: AsyncSession = Depends(get_db)):
    """List all conversations for a business with lead info, ordered by latest message timestamp."""
    result = await db.execute(
        select(Conversation)
        .options(selectinload(Conversation.lead), selectinload(Conversation.messages))
        .where(Conversation.business_id == business_id)
    )
    conversations = result.scalars().all()

    resp_list = []
    for conv in conversations:
        # Get latest message
        last_msg = conv.messages[-1] if conv.messages else None
        last_text = last_msg.message_text if last_msg else None
        last_time = last_msg.created_at if last_msg else conv.created_at
        last_sender = last_msg.sender_type if last_msg else None

        # Unread customer messages
        unread = 0
        if conv.messages:
            for m in reversed(conv.messages):
                if m.sender_type == 'customer':
                    unread += 1
                else:
                    break

        item = ConversationResponse(
            id=conv.id,
            lead_id=conv.lead_id,
            business_id=conv.business_id,
            created_at=conv.created_at,
            lead=conv.lead,
            last_message=last_text,
            last_message_time=last_time,
            last_sender_type=last_sender,
            unread_count=unread,
        )
        resp_list.append((last_time or conv.created_at, item))

    # Sort descending by latest message time
    resp_list.sort(key=lambda x: x[0], reverse=True)
    return [x[1] for x in resp_list]


@router.get("/{conversation_id}/messages", response_model=List[MessageResponse])
async def get_messages(conversation_id: int, db: AsyncSession = Depends(get_db)):
    """Get all messages for a conversation."""
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
    )
    messages = result.scalars().all()
    if not messages:
        # Check if conversation exists
        conv = await db.execute(select(Conversation).where(Conversation.id == conversation_id))
        if not conv.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Conversation not found")
    return messages


@router.post("/{conversation_id}/reply")
async def manual_reply(conversation_id: int, data: ManualReplyRequest, db: AsyncSession = Depends(get_db)):
    """Send a manual reply — delivers via WhatsApp, saves in DB, and marks lead as 'handover' so AI stops."""
    if not data.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Get conversation with lead
    result = await db.execute(
        select(Conversation)
        .options(selectinload(Conversation.lead))
        .where(Conversation.id == conversation_id)
    )
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    lead = conv.lead
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found for this conversation")

    phone = lead.phone_number

    # Get WhatsApp connection settings to determine send mode
    settings_result = await db.execute(select(AISetting).where(AISetting.business_id == conv.business_id))
    settings = settings_result.scalar_one_or_none()
    wa_mode = getattr(settings, "wa_connection_mode", "qr") or "qr"

    # Send message via WhatsApp
    send_success = False
    send_error = None
    try:
        if wa_mode == "cloud_api":
            from routers.whatsapp import _send_cloud_api_text
            result = await _send_cloud_api_text(phone, data.message.strip(), settings)
            send_success = result.get("success", False)
            if not send_success:
                send_error = result.get("error", "Unknown error")
        else:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"{BRIDGE_URL}/send",
                    json={"phone": phone, "message": data.message.strip(), "business_id": conv.business_id},
                )
                resp = r.json()
                send_success = resp.get("success", True)
                if not send_success:
                    send_error = resp.get("error", "Bridge error")
    except Exception as e:
        send_error = f"{type(e).__name__}: {e}"
        logger.error(f"[ManualReply] Send failed to {phone}: {send_error}")

    # Save message in DB (even if send failed — so it's recorded)
    msg = Message(
        conversation_id=conversation_id,
        sender_type="human",
        message_text=data.message.strip(),
    )
    db.add(msg)

    # Mark lead as 'handover' — AI will stop replying to this number
    if lead.lead_status != "handover":
        lead.lead_status = "handover"
        logger.info(f"[ManualReply] Lead {phone} marked as handover — AI will stop replying")

    await db.flush()
    await db.refresh(msg)

    return {
        "success": send_success,
        "message_id": msg.id,
        "error": send_error,
        "handover": True,
    }


@router.put("/{conversation_id}/lead-status")
async def update_lead_status(conversation_id: int, data: LeadStatusUpdate, db: AsyncSession = Depends(get_db)):
    """Update lead status — use to resume AI (set status back from 'handover') or change manually."""
    result = await db.execute(
        select(Conversation)
        .options(selectinload(Conversation.lead))
        .where(Conversation.id == conversation_id)
    )
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    lead = conv.lead
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    old_status = lead.lead_status
    lead.lead_status = data.status
    await db.flush()

    logger.info(f"[Conversations] Lead {lead.phone_number} status changed: {old_status} → {data.status}")
    return {"success": True, "old_status": old_status, "new_status": data.status}

