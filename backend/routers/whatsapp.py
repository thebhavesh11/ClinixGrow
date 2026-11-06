"""WhatsApp bridge proxy router + Cloud API webhook handler."""

import os
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from schemas import WhatsAppWebhook, WhatsAppOutgoingWebhook, ChatSyncPayload
from models import AISetting, Lead, Conversation, Message
from datetime import datetime
import httpx

logger = logging.getLogger(__name__)

BRIDGE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3001")
GRAPH_API_VERSION = "v21.0"
GRAPH_API_BASE = f"https://graph.facebook.com/{GRAPH_API_VERSION}"

router = APIRouter(prefix="/api/whatsapp", tags=["WhatsApp"])


# ── Helper: Get current connection mode from DB ──────────────────────
async def _get_wa_settings(db: AsyncSession, business_id: int = 1):
    """Get the current WhatsApp connection settings."""
    result = await db.execute(select(AISetting).where(AISetting.business_id == business_id))
    return result.scalar_one_or_none()


# ══════════════════════════════════════════════════════════════════════
#  SHARED ENDPOINTS (work for both modes)
# ══════════════════════════════════════════════════════════════════════

@router.get("/status")
async def whatsapp_status(business_id: int = Query(1), db: AsyncSession = Depends(get_db)):
    """Get WhatsApp connection status — adapts to current mode and scoped to business_id."""
    settings = await _get_wa_settings(db, business_id)
    mode = getattr(settings, "wa_connection_mode", "qr") or "qr"

    if mode == "cloud_api":
        # Cloud API mode — check if credentials are configured
        has_creds = bool(
            getattr(settings, "wa_phone_number_id", "")
            and getattr(settings, "wa_access_token", "")
        )
        if has_creds:
            # Verify token by making a lightweight API call
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    r = await client.get(
                        f"{GRAPH_API_BASE}/{settings.wa_phone_number_id}",
                        headers={"Authorization": f"Bearer {settings.wa_access_token}"},
                    )
                    if r.status_code == 200:
                        data = r.json()
                        return {
                            "connected": True,
                            "hasQR": False,
                            "mode": "cloud_api",
                            "business_id": business_id,
                            "info": {
                                "pushname": data.get("verified_name", "WhatsApp Business"),
                                "platform": "Cloud API",
                                "phone_number": data.get("display_phone_number", ""),
                            },
                            "error": None,
                        }
                    else:
                        return {
                            "connected": False,
                            "hasQR": False,
                            "mode": "cloud_api",
                            "business_id": business_id,
                            "info": None,
                            "error": f"Invalid credentials (HTTP {r.status_code})",
                        }
            except Exception as e:
                logger.warning(f"[WhatsApp] Cloud API status check failed: {e}")
                return {
                    "connected": False,
                    "hasQR": False,
                    "mode": "cloud_api",
                    "business_id": business_id,
                    "info": None,
                    "error": f"Connection check failed: {type(e).__name__}",
                }
        else:
            return {
                "connected": False,
                "hasQR": False,
                "mode": "cloud_api",
                "business_id": business_id,
                "info": None,
                "error": "Cloud API credentials not configured",
            }
    else:
        # QR mode — proxy to bridge with business_id
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(f"{BRIDGE_URL}/status?business_id={business_id}")
                data = r.json()
                data["mode"] = "qr"
                data["business_id"] = business_id
                return data
        except httpx.TimeoutException:
            logger.warning(f"[WhatsApp] Bridge status check timed out for biz {business_id}")
            return {"connected": False, "info": None, "hasQR": False, "mode": "qr", "business_id": business_id, "error": "Bridge timeout"}
        except Exception as e:
            logger.warning(f"[WhatsApp] Bridge unreachable: {type(e).__name__}")
            return {"connected": False, "info": None, "hasQR": False, "mode": "qr", "business_id": business_id, "error": "Bridge unreachable"}


@router.get("/qr")
async def whatsapp_qr(business_id: int = Query(1)):
    """Get QR code from bridge scoped to business_id."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{BRIDGE_URL}/qr?business_id={business_id}")
            return r.json()
    except httpx.TimeoutException:
        logger.warning(f"[WhatsApp] QR fetch timed out for biz {business_id}")
        return {"qr": None, "business_id": business_id, "error": "Bridge timeout"}
    except Exception as e:
        logger.warning(f"[WhatsApp] QR fetch failed: {type(e).__name__}")
        return {"qr": None, "business_id": business_id, "error": "Bridge unreachable"}


@router.post("/send")
async def send_message(phone: str, message: str, business_id: int = Query(1), db: AsyncSession = Depends(get_db)):
    """Send a message — routes to QR bridge or Cloud API based on mode."""
    settings = await _get_wa_settings(db, business_id)
    mode = getattr(settings, "wa_connection_mode", "qr") or "qr"

    if mode == "cloud_api":
        return await _send_cloud_api_text(phone, message, settings)
    else:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"{BRIDGE_URL}/send",
                    json={"phone": phone, "message": message, "business_id": business_id},
                )
                return r.json()
        except httpx.TimeoutException:
            logger.error(f"[WhatsApp] Send message timed out for {phone} (biz {business_id})")
            return {"success": False, "error": "Bridge timeout"}
        except Exception as e:
            logger.error(f"[WhatsApp] Send message failed: {type(e).__name__}: {e}")
            return {"success": False, "error": str(e)}


@router.post("/disconnect")
async def whatsapp_disconnect(business_id: int = Query(1)):
    """Disconnect/logout WhatsApp session for a specific business (QR mode only)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{BRIDGE_URL}/logout?business_id={business_id}", json={"business_id": business_id})
            return r.json()
    except httpx.TimeoutException:
        logger.error(f"[WhatsApp] Disconnect timed out for biz {business_id}")
        return {"success": False, "error": "Bridge timeout"}
    except Exception as e:
        logger.error(f"[WhatsApp] Disconnect failed: {type(e).__name__}: {e}")
        return {"success": False, "error": str(e)}


@router.post("/restart")
async def whatsapp_restart(business_id: int = Query(1)):
    """Restart WhatsApp client for a specific business (QR mode only)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{BRIDGE_URL}/restart?business_id={business_id}", json={"business_id": business_id})
            return r.json()
    except httpx.TimeoutException:
        logger.error(f"[WhatsApp] Restart timed out for biz {business_id}")
        return {"success": False, "error": "Bridge timeout"}
    except Exception as e:
        logger.error(f"[WhatsApp] Restart failed: {type(e).__name__}: {e}")
        return {"success": False, "error": str(e)}


@router.get("/chats")
async def whatsapp_chats(business_id: int = Query(1)):
    """Get recent WhatsApp chats from bridge for a specific business."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{BRIDGE_URL}/chats?business_id={business_id}")
            return r.json()
    except Exception as e:
        logger.warning(f"[WhatsApp] Failed to fetch chats from bridge for biz {business_id}: {e}")
        return {"success": False, "connected": False, "chats": [], "error": str(e)}


@router.get("/chats/{chat_id}/messages")
async def whatsapp_chat_messages(chat_id: str, limit: int = 40, business_id: int = Query(1)):
    """Get message history for a specific chat from bridge for a specific business."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{BRIDGE_URL}/chats/{chat_id}/messages?limit={limit}&business_id={business_id}")
            return r.json()
    except Exception as e:
        logger.warning(f"[WhatsApp] Failed to fetch chat messages for {chat_id} (biz {business_id}): {e}")
        return {"success": False, "messages": [], "error": str(e)}


# Active business tracking for single-session WhatsApp bridge
_active_business_id: int = 1

def get_active_business_id() -> int:
    return _active_business_id

def set_active_business_id(biz_id: int):
    global _active_business_id
    _active_business_id = biz_id


@router.get("/active-business")
async def get_active_business():
    """Get the currently active business ID for WhatsApp automation."""
    return {"business_id": _active_business_id}


@router.post("/active-business")
async def set_active_business(data: dict):
    """Set the active business ID for WhatsApp automation."""
    biz_id = int(data.get("business_id", 1))
    set_active_business_id(biz_id)
    logger.info(f"[WhatsApp] Active business set to {biz_id}")
    return {"business_id": _active_business_id}


@router.post("/webhook")
async def webhook(data: WhatsAppWebhook, db: AsyncSession = Depends(get_db)):
    """Receive incoming WhatsApp messages from bridge (QR mode)."""
    target_biz_id = data.business_id if (data.business_id and data.business_id > 0) else _active_business_id
    logger.info(f"[Webhook] Received message from {data.phone} (biz={target_biz_id}, should_reply={data.should_reply}): {data.message[:50]}...")
    try:
        from automation.engine import process_incoming_message
        result = await process_incoming_message(
            phone=data.phone,
            message=data.message,
            name=data.name or "Unknown",
            business_id=target_biz_id,
            db=db,
            reply_to=data.reply_to,
            should_reply=data.should_reply,
        )
        return {"status": "processed", "result": result}
    except Exception as e:
        logger.error(f"[Webhook] Error processing message from {data.phone}: {type(e).__name__}: {e}", exc_info=True)
        return {"status": "error", "error": str(e)}


@router.post("/outgoing-webhook")
async def outgoing_webhook(data: WhatsAppOutgoingWebhook, db: AsyncSession = Depends(get_db)):
    """Receive outgoing messages sent by the business owner directly from their WhatsApp phone/web."""
    target_biz_id = data.business_id if (data.business_id and data.business_id > 0) else _active_business_id
    logger.info(f"[OutgoingWebhook] Business {target_biz_id} owner sent message to {data.phone}: {data.message[:50]}...")
    try:
        from automation.engine import record_outgoing_human_message
        result = await record_outgoing_human_message(
            phone=data.phone,
            message=data.message,
            name=data.name or "Unknown",
            business_id=target_biz_id,
            db=db,
        )
        return {"status": "recorded", "result": result}
    except Exception as e:
        logger.error(f"[OutgoingWebhook] Error saving message to {data.phone}: {type(e).__name__}: {e}", exc_info=True)
        return {"status": "error", "error": str(e)}


@router.post("/sync-chats")
async def sync_chats(payload: ChatSyncPayload, db: AsyncSession = Depends(get_db)):
    """Bulk sync recent WhatsApp chats into leads, conversations, and messages (no AI reply)."""
    biz_id = payload.business_id if payload.business_id > 0 else 1
    logger.info(f"[SyncChats] Syncing {len(payload.chats)} WhatsApp chats for business {biz_id}")

    synced_count = 0
    for item in payload.chats:
        try:
            phone = item.phone.strip()
            if not phone:
                continue

            # 1. Find or create lead
            res = await db.execute(
                select(Lead).where(Lead.phone_number == phone, Lead.business_id == biz_id)
            )
            lead = res.scalar_one_or_none()
            if not lead:
                lead = Lead(phone_number=phone, name=item.name or "Unknown", business_id=biz_id)
                db.add(lead)
                await db.flush()
                await db.refresh(lead)
            elif item.name and item.name != "Unknown" and (not lead.name or lead.name == "Unknown"):
                lead.name = item.name
                await db.flush()

            # 2. Find or create conversation
            res = await db.execute(
                select(Conversation).where(
                    Conversation.lead_id == lead.id,
                    Conversation.business_id == biz_id,
                )
            )
            conv = res.scalar_one_or_none()
            if not conv:
                conv = Conversation(lead_id=lead.id, business_id=biz_id)
                db.add(conv)
                await db.flush()
                await db.refresh(conv)

            # 3. Check if conversation already has messages
            m_res = await db.execute(
                select(Message).where(Message.conversation_id == conv.id).limit(1)
            )
            existing_msg = m_res.scalar_one_or_none()
            if not existing_msg and item.last_message:
                msg_time = datetime.utcfromtimestamp(item.timestamp) if item.timestamp else datetime.utcnow()
                sender = "human" if item.from_me else "customer"
                msg = Message(
                    conversation_id=conv.id,
                    sender_type=sender,
                    message_text=item.last_message,
                    created_at=msg_time,
                )
                db.add(msg)
                await db.flush()

            synced_count += 1
        except Exception as e:
            logger.warning(f"[SyncChats] Error syncing chat {item.phone}: {e}")

    await db.commit()
    logger.info(f"[SyncChats] Successfully synced {synced_count} chats for business {biz_id}")
    return {"success": True, "synced_count": synced_count}


@router.post("/trigger-sync")
async def trigger_sync(business_id: int = Query(1)):
    """Trigger WhatsApp bridge to sync recent chats from active session."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{BRIDGE_URL}/sync-chats", json={"business_id": business_id})
            return r.json()
    except Exception as e:
        logger.warning(f"[TriggerSync] Failed to trigger sync for biz {business_id}: {e}")
        return {"success": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════════════
#  CLOUD API ENDPOINTS
# ══════════════════════════════════════════════════════════════════════

@router.get("/cloud/webhook")
async def cloud_webhook_verify(
    db: AsyncSession = Depends(get_db),
    mode: str = Query(None, alias="hub.mode"),
    token: str = Query(None, alias="hub.verify_token"),
    challenge: str = Query(None, alias="hub.challenge"),
):
    """Meta webhook verification endpoint."""
    logger.info(f"[CloudAPI] Webhook verify request — mode={mode}, challenge={challenge is not None}")
    settings = await _get_wa_settings(db)
    expected_token = getattr(settings, "wa_verify_token", "") or ""

    if mode == "subscribe" and token and token == expected_token:
        logger.info("[CloudAPI] Webhook verified successfully ✅")
        return PlainTextResponse(challenge or "")

    logger.warning(f"[CloudAPI] Webhook verification failed — mode={mode}, token mismatch (got='{token}', expected='{expected_token}')")
    raise HTTPException(status_code=403, detail="Verification failed")


@router.post("/cloud/webhook")
async def cloud_webhook_receive(request: Request, db: AsyncSession = Depends(get_db)):
    """Receive incoming messages from Meta Cloud API."""
    try:
        body = await request.json()
    except Exception as e:
        logger.error(f"[CloudAPI] Failed to parse webhook body: {e}")
        return {"status": "ok"}

    logger.info(f"[CloudAPI] Webhook received — object={body.get('object', 'unknown')}")

    # Parse Meta webhook format
    # Structure: body.entry[].changes[].value.messages[]
    entries = body.get("entry", [])
    if not entries:
        logger.warning("[CloudAPI] Webhook has no entries — might be a status update")
        return {"status": "ok"}

    for entry in entries:
        for change in entry.get("changes", []):
            field = change.get("field", "")
            value = change.get("value", {})

            # Skip non-message webhooks (like statuses, errors)
            if field != "messages":
                logger.info(f"[CloudAPI] Skipping non-message webhook field: {field}")
                continue

            messages = value.get("messages", [])
            contacts = value.get("contacts", [])
            statuses = value.get("statuses", [])

            # Skip status-only updates (delivered, read, etc.)
            if not messages and statuses:
                logger.info(f"[CloudAPI] Status update received ({len(statuses)} statuses) — skipping")
                continue

            if not messages:
                logger.info("[CloudAPI] No messages in this webhook")
                continue

            # Build contact name map
            contact_map = {}
            for c in contacts:
                wa_id = c.get("wa_id", "")
                name = c.get("profile", {}).get("name", "Unknown")
                contact_map[wa_id] = name

            # Resolve business_id from the phone_number_id in metadata
            metadata = value.get("metadata", {})
            recv_phone_id = metadata.get("phone_number_id", "")
            resolved_bid = 1  # default fallback
            if recv_phone_id:
                from models import AISetting
                bid_result = await db.execute(
                    select(AISetting).where(AISetting.wa_phone_number_id == recv_phone_id)
                )
                matched_settings = bid_result.scalar_one_or_none()
                if matched_settings:
                    resolved_bid = matched_settings.business_id

            for msg in messages:
                msg_type = msg.get("type", "")
                phone = msg.get("from", "")
                name = contact_map.get(phone, "Unknown")

                # Extract message text based on type
                text = ""
                if msg_type == "text":
                    text = msg.get("text", {}).get("body", "")
                elif msg_type == "button":
                    text = msg.get("button", {}).get("text", "")
                elif msg_type == "interactive":
                    interactive = msg.get("interactive", {})
                    if interactive.get("type") == "button_reply":
                        text = interactive.get("button_reply", {}).get("title", "")
                    elif interactive.get("type") == "list_reply":
                        text = interactive.get("list_reply", {}).get("title", "")
                elif msg_type in ("image", "video", "document", "audio", "sticker", "location", "contacts"):
                    text = f"[{msg_type} message received]"
                else:
                    text = f"[{msg_type} message received]"

                if not text or not phone:
                    logger.warning(f"[CloudAPI] Skipping message — no text or phone: type={msg_type}")
                    continue

                logger.info(f"[CloudAPI] 📩 Message from {name} ({phone}): {text[:80]}...")

                try:
                    from automation.engine import process_incoming_message
                    result = await process_incoming_message(
                        phone=phone,
                        message=text,
                        name=name,
                        business_id=resolved_bid,
                        db=db,
                    )
                    logger.info(f"[CloudAPI] ✅ Processed message from {phone} — reply={bool(result.get('reply'))}")
                except Exception as e:
                    logger.error(f"[CloudAPI] ❌ Error processing message from {phone}: {type(e).__name__}: {e}", exc_info=True)

    return {"status": "ok"}


@router.post("/cloud/subscribe")
async def cloud_subscribe_webhook(webhook_url: str, business_id: int = Query(1), db: AsyncSession = Depends(get_db)):
    """Subscribe the webhook with Meta — registers the callback URL programmatically."""
    settings = await _get_wa_settings(db, business_id)
    if not settings:
        return {"success": False, "error": "No settings configured"}

    app_id = getattr(settings, "wa_app_id", "") or ""
    app_secret = getattr(settings, "wa_app_secret", "") or ""
    verify_token = getattr(settings, "wa_verify_token", "") or ""

    if not app_id or not app_secret:
        return {"success": False, "error": "App ID and App Secret are required to subscribe webhook"}
    if not verify_token:
        return {"success": False, "error": "Verify Token is required"}

    # App access token = app_id|app_secret
    app_access_token = f"{app_id}|{app_secret}"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{GRAPH_API_BASE}/{app_id}/subscriptions",
                data={
                    "object": "whatsapp_business_account",
                    "callback_url": webhook_url,
                    "verify_token": verify_token,
                    "fields": "messages",
                    "access_token": app_access_token,
                },
            )
            if r.status_code == 200 and r.json().get("success"):
                logger.info(f"[CloudAPI] Webhook subscribed successfully: {webhook_url}")
                return {"success": True, "message": "Webhook subscribed! Meta will now send messages to your URL."}
            else:
                err = _parse_graph_error(r)
                logger.error(f"[CloudAPI] Webhook subscribe failed: {err}")
                return {"success": False, "error": err.get("message", f"HTTP {r.status_code}"), "error_details": err}
    except Exception as e:
        return {"success": False, "error": f"Subscribe failed: {type(e).__name__}: {e}"}


@router.get("/cloud/webhook-status")
async def cloud_webhook_status(business_id: int = Query(1), db: AsyncSession = Depends(get_db)):
    """Check current webhook subscription status."""
    settings = await _get_wa_settings(db, business_id)
    if not settings:
        return {"subscribed": False, "error": "No settings configured"}

    app_id = getattr(settings, "wa_app_id", "") or ""
    app_secret = getattr(settings, "wa_app_secret", "") or ""

    if not app_id or not app_secret:
        return {"subscribed": False, "error": "App ID and App Secret required"}

    app_access_token = f"{app_id}|{app_secret}"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{GRAPH_API_BASE}/{app_id}/subscriptions",
                params={"access_token": app_access_token},
            )
            if r.status_code == 200:
                data = r.json().get("data", [])
                wa_sub = None
                for sub in data:
                    if sub.get("object") == "whatsapp_business_account":
                        wa_sub = sub
                        break
                if wa_sub:
                    return {
                        "subscribed": True,
                        "callback_url": wa_sub.get("callback_url", ""),
                        "fields": [f.get("name") for f in wa_sub.get("fields", [])],
                        "active": wa_sub.get("active", False),
                    }
                else:
                    return {"subscribed": False, "error": "No WhatsApp webhook subscription found"}
            else:
                err = _parse_graph_error(r)
                return {"subscribed": False, "error": err.get("message", f"HTTP {r.status_code}")}
    except Exception as e:
        return {"subscribed": False, "error": f"{type(e).__name__}: {e}"}



@router.post("/cloud/test")
async def cloud_test_connection(business_id: int = Query(1), db: AsyncSession = Depends(get_db)):
    """Test Cloud API connection — validates each credential step-by-step like n8n."""
    settings = await _get_wa_settings(db, business_id)
    if not settings:
        return {"success": False, "error": "No settings configured", "error_details": None}

    token = getattr(settings, "wa_access_token", "") or ""
    phone_id = getattr(settings, "wa_phone_number_id", "") or ""
    biz_id = getattr(settings, "wa_business_account_id", "") or ""

    # Step 0: Check required fields
    missing = []
    if not token:
        missing.append("Access Token")
    if not phone_id:
        missing.append("Phone Number ID")
    if not biz_id:
        missing.append("Business Account ID")
    if missing:
        return {
            "success": False,
            "step": "validation",
            "error": f"Missing required fields: {', '.join(missing)}",
            "error_details": None,
        }

    headers = {"Authorization": f"Bearer {token}"}
    checks = []

    try:
        async with httpx.AsyncClient(timeout=15) as client:

            # Step 1: Validate Access Token
            r1 = await client.get(f"{GRAPH_API_BASE}/debug_token", params={"input_token": token}, headers=headers)
            if r1.status_code == 200:
                token_data = r1.json().get("data", {})
                is_valid = token_data.get("is_valid", False)
                app_id = token_data.get("app_id", "")
                token_type = token_data.get("type", "")
                expires = token_data.get("expires_at", 0)
                if is_valid:
                    checks.append({"step": "Access Token", "status": "✅ Valid", "detail": f"App ID: {app_id}, Type: {token_type}"})
                    if expires and expires > 0:
                        import time
                        remaining = expires - int(time.time())
                        if remaining < 86400:
                            checks[-1]["warning"] = f"Token expires in {remaining // 3600} hours!"
                else:
                    error_info = token_data.get("error", {})
                    return {
                        "success": False,
                        "step": "Access Token",
                        "error": "Access Token is invalid or expired",
                        "error_details": {
                            "code": error_info.get("code", ""),
                            "message": error_info.get("message", "Token validation failed"),
                            "subcode": error_info.get("subcode", ""),
                        },
                        "checks": checks,
                    }
            else:
                err = _parse_graph_error(r1)
                return {
                    "success": False,
                    "step": "Access Token",
                    "error": f"Token verification failed (HTTP {r1.status_code})",
                    "error_details": err,
                    "checks": checks,
                }

            # Step 2: Validate Phone Number ID
            r2 = await client.get(
                f"{GRAPH_API_BASE}/{phone_id}",
                params={"fields": "verified_name,display_phone_number,quality_rating,platform_type,code_verification_status"},
                headers=headers,
            )
            if r2.status_code == 200:
                phone_data = r2.json()
                checks.append({
                    "step": "Phone Number ID",
                    "status": "✅ Valid",
                    "detail": f"{phone_data.get('display_phone_number', 'N/A')} — {phone_data.get('verified_name', 'N/A')}",
                    "quality": phone_data.get("quality_rating", "N/A"),
                })
            else:
                err = _parse_graph_error(r2)
                return {
                    "success": False,
                    "step": "Phone Number ID",
                    "error": f"Phone Number ID '{phone_id}' is invalid or not accessible",
                    "error_details": err,
                    "checks": checks,
                }

            # Step 3: Validate Business Account ID
            r3 = await client.get(
                f"{GRAPH_API_BASE}/{biz_id}",
                params={"fields": "name,currency,timezone_id,message_template_namespace"},
                headers=headers,
            )
            if r3.status_code == 200:
                biz_data = r3.json()
                checks.append({
                    "step": "Business Account ID",
                    "status": "✅ Valid",
                    "detail": f"{biz_data.get('name', 'N/A')} — Timezone: {biz_data.get('timezone_id', 'N/A')}",
                })
            else:
                err = _parse_graph_error(r3)
                return {
                    "success": False,
                    "step": "Business Account ID",
                    "error": f"Business Account ID '{biz_id}' is invalid or not accessible",
                    "error_details": err,
                    "checks": checks,
                }

            # All passed!
            return {
                "success": True,
                "checks": checks,
                "verified_name": phone_data.get("verified_name", ""),
                "phone_number": phone_data.get("display_phone_number", ""),
                "quality_rating": phone_data.get("quality_rating", ""),
                "business_name": biz_data.get("name", ""),
            }

    except httpx.TimeoutException:
        return {"success": False, "step": "connection", "error": "Connection timed out — check your internet", "error_details": None, "checks": checks}
    except Exception as e:
        return {"success": False, "step": "connection", "error": f"Connection failed: {type(e).__name__}: {e}", "error_details": None, "checks": checks}


def _parse_graph_error(response) -> dict:
    """Parse Meta Graph API error response into a readable dict."""
    try:
        data = response.json()
        err = data.get("error", {})
        return {
            "http_status": response.status_code,
            "code": err.get("code", ""),
            "subcode": err.get("error_subcode", ""),
            "type": err.get("type", ""),
            "message": err.get("message", f"HTTP {response.status_code}"),
            "fbtrace_id": err.get("fbtrace_id", ""),
        }
    except Exception:
        return {"http_status": response.status_code, "message": f"HTTP {response.status_code}", "code": "", "type": ""}


# ── Cloud API Helper Functions ────────────────────────────────────────

async def _send_cloud_api_text(phone: str, message: str, settings) -> dict:
    """Send a text message via WhatsApp Cloud API."""
    phone_id = getattr(settings, "wa_phone_number_id", "") or ""
    token = getattr(settings, "wa_access_token", "") or ""

    if not phone_id or not token:
        return {"success": False, "error": "Cloud API credentials not configured"}

    # Clean phone number — remove @c.us suffix, +, spaces
    clean_phone = phone.replace("@c.us", "").replace("@g.us", "").replace("+", "").replace(" ", "").strip()

    url = f"{GRAPH_API_BASE}/{phone_id}/messages"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": clean_phone,
        "type": "text",
        "text": {"preview_url": False, "body": message},
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, headers=headers, json=payload)
            if r.status_code in (200, 201):
                logger.info(f"[CloudAPI] Message sent to {clean_phone}")
                return {"success": True}
            else:
                error_data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                error_msg = error_data.get("error", {}).get("message", f"HTTP {r.status_code}")
                logger.error(f"[CloudAPI] Send failed: {error_msg}")
                return {"success": False, "error": error_msg}
    except Exception as e:
        logger.error(f"[CloudAPI] Send error: {type(e).__name__}: {e}")
        return {"success": False, "error": str(e)}


async def send_cloud_api_media(phone: str, media_url: str, filename: str, caption: str, settings) -> dict:
    """Send a media file via WhatsApp Cloud API using a URL."""
    phone_id = getattr(settings, "wa_phone_number_id", "") or ""
    token = getattr(settings, "wa_access_token", "") or ""

    if not phone_id or not token:
        return {"success": False, "error": "Cloud API credentials not configured"}

    clean_phone = phone.replace("@c.us", "").replace("@g.us", "").replace("+", "").replace(" ", "").strip()

    # Determine media type from filename
    ext = (filename or "").rsplit(".", 1)[-1].lower()
    if ext in ("jpg", "jpeg", "png", "webp"):
        media_type = "image"
    elif ext in ("mp4", "3gp"):
        media_type = "video"
    elif ext == "pdf":
        media_type = "document"
    else:
        media_type = "document"

    url = f"{GRAPH_API_BASE}/{phone_id}/messages"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": clean_phone,
        "type": media_type,
        media_type: {
            "link": media_url,
            "caption": caption or "",
        },
    }
    # Documents need filename
    if media_type == "document":
        payload[media_type]["filename"] = filename or "file"

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=payload)
            if r.status_code in (200, 201):
                logger.info(f"[CloudAPI] Media sent to {clean_phone}: {filename}")
                return {"success": True}
            else:
                error_data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                error_msg = error_data.get("error", {}).get("message", f"HTTP {r.status_code}")
                logger.error(f"[CloudAPI] Media send failed: {error_msg}")
                return {"success": False, "error": error_msg}
    except Exception as e:
        logger.error(f"[CloudAPI] Media send error: {type(e).__name__}: {e}")
        return {"success": False, "error": str(e)}
