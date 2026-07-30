"""AI Settings CRUD router with API key validation."""

import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import AISetting
from schemas import AISettingCreate, AISettingUpdate, AISettingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai-settings", tags=["AI Settings"])


class ValidateKeyRequest(BaseModel):
    provider: str
    api_key: str
    model: str = ""


class ValidateKeyResponse(BaseModel):
    valid: bool
    message: str


@router.get("", response_model=AISettingResponse)
async def get_ai_settings(business_id: int = 1, db: AsyncSession = Depends(get_db)):
    """Get AI settings for a business."""
    result = await db.execute(select(AISetting).where(AISetting.business_id == business_id))
    settings = result.scalar_one_or_none()
    if not settings:
        raise HTTPException(status_code=404, detail="AI settings not found")
    return settings


@router.post("", response_model=AISettingResponse)
async def create_ai_settings(data: AISettingCreate, db: AsyncSession = Depends(get_db)):
    """Create AI settings."""
    setting = AISetting(**data.model_dump())
    db.add(setting)
    await db.flush()
    await db.refresh(setting)
    return setting


@router.put("", response_model=AISettingResponse)
async def update_ai_settings(data: AISettingUpdate, business_id: int = 1, db: AsyncSession = Depends(get_db)):
    """Update AI settings for a business."""
    result = await db.execute(select(AISetting).where(AISetting.business_id == business_id))
    settings = result.scalar_one_or_none()
    if not settings:
        raise HTTPException(status_code=404, detail="AI settings not found")
    for key, value in data.model_dump().items():
        setattr(settings, key, value)
    await db.flush()
    await db.refresh(settings)
    logger.info(f"[AI Settings] Updated: provider={settings.provider}, model={settings.model}")
    return settings


@router.post("/validate", response_model=ValidateKeyResponse)
async def validate_api_key(data: ValidateKeyRequest):
    """Validate an API key by making a test request to the provider."""
    provider = data.provider.lower()
    api_key = data.api_key.strip()

    if not api_key:
        return ValidateKeyResponse(valid=False, message="API key is empty")

    try:
        if provider == "openai":
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=api_key)
            response = await client.chat.completions.create(
                model=data.model or "gpt-4o-mini",
                messages=[{"role": "user", "content": "Hi"}],
                max_tokens=5,
            )
            return ValidateKeyResponse(valid=True, message=f"Connected! Model: {data.model or 'gpt-4o-mini'}")

        elif provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(data.model or "gemini-1.5-flash")
            response = model.generate_content("Hi", generation_config=genai.GenerationConfig(max_output_tokens=5))
            return ValidateKeyResponse(valid=True, message=f"Connected! Model: {data.model or 'gemini-1.5-flash'}")

        elif provider == "anthropic":
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=api_key)
            response = await client.messages.create(
                model=data.model or "claude-3-5-sonnet-20241022",
                messages=[{"role": "user", "content": "Hi"}],
                max_tokens=5,
            )
            return ValidateKeyResponse(valid=True, message=f"Connected! Model: {data.model or 'claude-3-5-sonnet-20241022'}")

        elif provider == "openrouter":
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=api_key, base_url="https://openrouter.ai/api/v1")
            response = await client.chat.completions.create(
                model=data.model or "openai/gpt-4o-mini",
                messages=[{"role": "user", "content": "Hi"}],
                max_tokens=5,
            )
            return ValidateKeyResponse(valid=True, message=f"Connected! Model: {data.model or 'openai/gpt-4o-mini'}")

        else:
            return ValidateKeyResponse(valid=False, message=f"Unknown provider: {provider}")

    except Exception as e:
        error_msg = str(e)
        logger.warning(f"[AI Settings] Validation failed for {provider}: {type(e).__name__}: {error_msg[:200]}")
        if "auth" in error_msg.lower() or "api key" in error_msg.lower() or "invalid" in error_msg.lower():
            return ValidateKeyResponse(valid=False, message="Invalid API key. Please check and try again.")
        elif "model" in error_msg.lower():
            return ValidateKeyResponse(valid=False, message=f"API key works but model not found: {data.model}")
        else:
            return ValidateKeyResponse(valid=False, message=f"Connection failed: {error_msg[:150]}")
