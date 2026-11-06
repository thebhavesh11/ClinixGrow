"""Pydantic schemas for request/response validation."""

from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime


# ── Business ──────────────────────────────────────────────
class BusinessBase(BaseModel):
    name: str = "My Business"
    industry: str = ""
    services: str = ""
    pricing: str = ""
    faqs: str = ""
    location: str = ""
    offers: str = ""
    working_hours: str = ""
    portal_token: Optional[str] = None
    portal_pin: Optional[str] = None
    logo_url: Optional[str] = ""


class BusinessCreate(BusinessBase):
    pass


class BusinessUpdate(BusinessBase):
    pass


class BusinessResponse(BusinessBase):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True


# ── AI Settings ───────────────────────────────────────────
class AISettingBase(BaseModel):
    provider: str = "openai"
    api_key: str = ""
    model: str = "gpt-4o-mini"
    temperature: float = 0.7
    max_tokens: int = 500
    system_prompt: str = ""
    scoring_prompt: str = ""
    group_replies: int = 0
    reply_delay: int = 0
    typing_indicator: int = 0
    reply_to_contacts: int = 1
    auto_handover: int = 0
    handover_after: int = 10
    
    reminder_enabled: int = 0
    reminder_time_mins: int = 30
    reminder_message_template: str = "Hi {name}, this is a reminder for your appointment at ClinixGrow at {time}."
    feedback_enabled: int = 0
    feedback_time_mins: int = 120
    feedback_message_template: str = "Hi {name}, thank you for your visit to ClinixGrow! Please share your feedback: [Link]"

    wa_connection_mode: str = "qr"
    wa_app_id: str = ""
    wa_app_secret: str = ""
    wa_phone_number_id: str = ""
    wa_access_token: str = ""
    wa_verify_token: str = ""
    wa_business_account_id: str = ""

    @field_validator("temperature")
    @classmethod
    def clamp_temperature(cls, v):
        return max(0.0, min(2.0, v))

    @field_validator("max_tokens")
    @classmethod
    def clamp_max_tokens(cls, v):
        return max(1, min(8000, v))

    @field_validator("reply_delay")
    @classmethod
    def clamp_reply_delay(cls, v):
        return max(0, min(120, v))

    @field_validator("handover_after")
    @classmethod
    def clamp_handover_after(cls, v):
        return max(1, min(1000, v))

    @field_validator("group_replies", "typing_indicator", "reply_to_contacts", "auto_handover")
    @classmethod
    def clamp_toggle(cls, v):
        return 1 if v else 0


class AISettingCreate(AISettingBase):
    business_id: int = 1


class AISettingUpdate(AISettingBase):
    pass


class AISettingResponse(AISettingBase):
    id: int
    business_id: int
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ── Lead ──────────────────────────────────────────────────
class LeadResponse(BaseModel):
    id: int
    phone_number: str
    name: str
    business_id: int
    lead_score: int
    lead_status: str
    created_at: datetime

    class Config:
        from_attributes = True


# ── Conversation ─────────────────────────────────────────
class ConversationResponse(BaseModel):
    id: int
    lead_id: int
    business_id: int
    created_at: datetime
    lead: Optional[LeadResponse] = None
    last_message: Optional[str] = None
    last_message_time: Optional[datetime] = None
    last_sender_type: Optional[str] = None
    unread_count: Optional[int] = 0

    class Config:
        from_attributes = True


# ── Message ───────────────────────────────────────────────
class MessageResponse(BaseModel):
    id: int
    conversation_id: int
    sender_type: str
    message_text: str
    created_at: datetime

    class Config:
        from_attributes = True


# ── Dashboard ─────────────────────────────────────────────
class DashboardResponse(BaseModel):
    total_messages_today: int = 0
    total_leads_today: int = 0
    hot_leads: int = 0
    warm_leads: int = 0
    cold_leads: int = 0
    spam_leads: int = 0
    active_conversations: int = 0
    total_leads: int = 0
    total_conversations: int = 0
    appointments_today: int = 0
    upcoming_appointments: int = 0
    calls_today: int = 0
    total_call_minutes: int = 0


# ── Business Media ────────────────────────────────────────
class BusinessMediaResponse(BaseModel):
    id: int
    business_id: int
    name: str
    description: str
    file_type: str
    original_filename: str
    created_at: datetime

    class Config:
        from_attributes = True


class BusinessMediaUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


# ── WhatsApp Webhook ─────────────────────────────────────
class WhatsAppWebhook(BaseModel):
    phone: str
    message: str
    name: Optional[str] = "Unknown"
    business_id: int = 1
    is_group: bool = False
    reply_to: Optional[str] = None
    should_reply: bool = True


class WhatsAppOutgoingWebhook(BaseModel):
    phone: str
    message: str
    name: Optional[str] = "Unknown"
    business_id: int = 1
    is_group: bool = False


# ── Working Hours ─────────────────────────────────────────
class WorkingHoursItem(BaseModel):
    day_of_week: int  # 0=Monday ... 6=Sunday
    is_open: int = 1
    start_time: str = "09:00"
    end_time: str = "18:00"
    break_start: str = ""
    break_end: str = ""
    slot_duration: int = 30

    @field_validator("day_of_week")
    @classmethod
    def validate_day(cls, v):
        if v < 0 or v > 6:
            raise ValueError("day_of_week must be 0 (Monday) to 6 (Sunday)")
        return v

    @field_validator("slot_duration")
    @classmethod
    def validate_slot_duration(cls, v):
        if v not in (15, 30, 45, 60):
            return 30
        return v

    @field_validator("is_open")
    @classmethod
    def validate_is_open(cls, v):
        return 1 if v else 0


class WorkingHoursResponse(WorkingHoursItem):
    id: int
    business_id: int

    class Config:
        from_attributes = True


class WorkingHoursUpdate(BaseModel):
    """Bulk update — list of all 7 days."""
    days: list[WorkingHoursItem]


# ── Appointment ───────────────────────────────────────────
class AppointmentCreate(BaseModel):
    lead_id: Optional[int] = None
    title: str = "Appointment"
    date: str  # "YYYY-MM-DD"
    start_time: str  # "HH:MM"
    end_time: str = ""  # auto-calculated from slot_duration if empty
    notes: str = ""
    booked_by: str = "manual"
    business_id: int = 1


class AppointmentUpdate(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    lead_id: Optional[int] = None


class AppointmentResponse(BaseModel):
    id: int
    business_id: int
    lead_id: Optional[int] = None
    title: str
    date: str
    start_time: str
    end_time: str
    status: str
    notes: str
    booked_by: str
    reminder_sent: int
    feedback_sent: int
    created_at: datetime
    lead: Optional[LeadResponse] = None

    class Config:
        from_attributes = True


class SlotResponse(BaseModel):
    time: str  # "09:00"
    end_time: str  # "09:30"
    available: bool


# ── Voice Agent ───────────────────────────────────────────
class VoiceSettingsResponse(BaseModel):
    id: int
    business_id: int
    vapi_api_key: str = ""
    vapi_assistant_id: str = ""
    vapi_phone_id: str = ""
    phone_number: str = ""
    agent_name: str = "AI Assistant"
    voice_provider: str = "11labs"
    voice_id: str = ""
    language: str = "hi-IN"
    first_message: str = ""
    system_prompt: str = ""
    can_book_appointments: int = 1
    can_transfer_call: int = 1
    webhook_secret: str = ""
    is_active: int = 0
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class VoiceSettingsUpdate(BaseModel):
    vapi_api_key: Optional[str] = None
    vapi_assistant_id: Optional[str] = None
    vapi_phone_id: Optional[str] = None
    phone_number: Optional[str] = None
    agent_name: Optional[str] = None
    voice_provider: Optional[str] = None
    voice_id: Optional[str] = None
    language: Optional[str] = None
    first_message: Optional[str] = None
    system_prompt: Optional[str] = None
    can_book_appointments: Optional[int] = None
    can_transfer_call: Optional[int] = None
    webhook_secret: Optional[str] = None
    is_active: Optional[int] = None


class CallLogResponse(BaseModel):
    id: int
    business_id: int
    lead_id: Optional[int] = None
    vapi_call_id: str = ""
    phone_number: str = ""
    direction: str = "inbound"
    status: str = "queued"
    duration_seconds: int = 0
    cost: float = 0.0
    recording_url: str = ""
    transcript: str = ""
    summary: str = ""
    ended_reason: str = ""
    appointments_booked: int = 0
    created_at: datetime
    lead: Optional[LeadResponse] = None

    class Config:
        from_attributes = True


class OutboundCallRequest(BaseModel):
    phone_number: str
    lead_id: Optional[int] = None
    business_id: int = 1
