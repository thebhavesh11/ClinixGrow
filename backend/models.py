"""SQLAlchemy ORM models for SmartFlow."""

from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from database import Base


class Business(Base):
    __tablename__ = "businesses"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, default="My Business")
    industry = Column(String(100), default="")
    services = Column(Text, default="")
    pricing = Column(Text, default="")
    faqs = Column(Text, default="")
    location = Column(String(255), default="")
    offers = Column(Text, default="")
    working_hours = Column(String(255), default="")
    portal_token = Column(String(64), unique=True, index=True, nullable=True)
    portal_pin = Column(String(20), nullable=True)
    logo_url = Column(String(500), default="")
    created_at = Column(DateTime, default=lambda: datetime.utcnow())

    leads = relationship("Lead", back_populates="business")
    conversations = relationship("Conversation", back_populates="business")
    ai_setting = relationship("AISetting", back_populates="business", uselist=False)

    def __repr__(self):
        return f"<Business id={self.id} name={self.name!r}>"


class Lead(Base):
    __tablename__ = "leads"

    id = Column(Integer, primary_key=True, index=True)
    phone_number = Column(String(20), nullable=False)
    name = Column(String(255), default="Unknown")
    business_id = Column(Integer, ForeignKey("businesses.id"), default=1)
    lead_score = Column(Integer, default=0)
    lead_status = Column(String(20), default="new")  # new, hot, warm, cold, spam
    created_at = Column(DateTime, default=lambda: datetime.utcnow())

    business = relationship("Business", back_populates="leads")
    conversations = relationship("Conversation", back_populates="lead")

    def __repr__(self):
        return f"<Lead id={self.id} phone={self.phone_number!r} status={self.lead_status!r}>"


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    lead_id = Column(Integer, ForeignKey("leads.id"), nullable=False)
    business_id = Column(Integer, ForeignKey("businesses.id"), default=1)
    created_at = Column(DateTime, default=lambda: datetime.utcnow())

    lead = relationship("Lead", back_populates="conversations")
    business = relationship("Business", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", order_by="Message.created_at")

    def __repr__(self):
        return f"<Conversation id={self.id} lead_id={self.lead_id}>"


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False)
    sender_type = Column(String(10), nullable=False)  # 'customer' or 'ai'
    message_text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.utcnow())

    conversation = relationship("Conversation", back_populates="messages")

    def __repr__(self):
        return f"<Message id={self.id} sender={self.sender_type!r}>"


class AISetting(Base):
    __tablename__ = "ai_settings"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), unique=True, default=1)
    provider = Column(String(50), default="openai")  # openai, gemini, openrouter
    api_key = Column(String(500), default="")
    model = Column(String(100), default="gpt-4o-mini")
    temperature = Column(Float, default=0.7)
    max_tokens = Column(Integer, default=500)
    system_prompt = Column(Text, default="")
    scoring_prompt = Column(Text, default="")
    group_replies = Column(Integer, default=0)  # 0=off, 1=on
    reply_delay = Column(Integer, default=0)  # seconds to wait before replying
    typing_indicator = Column(Integer, default=0)  # 0=off, 1=show typing during delay
    reply_to_contacts = Column(Integer, default=1)  # 1=reply to all, 0=only new/unsaved numbers
    auto_handover = Column(Integer, default=0)  # 0=off, 1=on
    handover_after = Column(Integer, default=10)  # number of AI replies before handover

    # Automation Settings
    reminder_enabled = Column(Integer, default=0)
    reminder_time_mins = Column(Integer, default=30)
    reminder_message_template = Column(Text, default="Hi {name}, this is a reminder for your appointment at ClinixGrow at {time}.")
    feedback_enabled = Column(Integer, default=0)
    feedback_time_mins = Column(Integer, default=120)
    feedback_message_template = Column(Text, default="Hi {name}, thank you for your visit to ClinixGrow! Please share your feedback: [Link]")

    # WhatsApp connection mode: "qr" (whatsapp-web.js) or "cloud_api" (Meta Cloud API)
    wa_connection_mode = Column(String(20), default="qr")
    wa_app_id = Column(String(100), default="")              # Facebook App ID
    wa_app_secret = Column(String(255), default="")          # Facebook App Secret
    wa_phone_number_id = Column(String(100), default="")     # Meta Phone Number ID
    wa_access_token = Column(String(500), default="")        # Permanent access token (System User)
    wa_verify_token = Column(String(100), default="")        # Webhook verification token
    wa_business_account_id = Column(String(100), default="") # WhatsApp Business Account ID

    updated_at = Column(DateTime, default=lambda: datetime.utcnow(), onupdate=lambda: datetime.utcnow())

    business = relationship("Business", back_populates="ai_setting")

    def __repr__(self):
        return f"<AISetting id={self.id} provider={self.provider!r} model={self.model!r}>"


class BusinessMedia(Base):
    __tablename__ = "business_media"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), default=1)
    name = Column(String(255), nullable=False)  # user-defined label e.g. "Price List"
    description = Column(Text, default="")  # when/how to use this media
    file_type = Column(String(20), nullable=False)  # image, pdf, video
    file_path = Column(String(500), nullable=False)  # path on disk
    original_filename = Column(String(255), default="")
    created_at = Column(DateTime, default=lambda: datetime.utcnow())

    business = relationship("Business")

    def __repr__(self):
        return f"<BusinessMedia id={self.id} name={self.name!r} type={self.file_type!r}>"


class WorkingHours(Base):
    __tablename__ = "working_hours"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), default=1)
    day_of_week = Column(Integer, nullable=False)  # 0=Monday, 1=Tuesday ... 6=Sunday
    is_open = Column(Integer, default=1)  # 0=closed, 1=open
    start_time = Column(String(5), default="09:00")  # HH:MM
    end_time = Column(String(5), default="18:00")
    break_start = Column(String(5), default="")  # optional lunch break
    break_end = Column(String(5), default="")
    slot_duration = Column(Integer, default=30)  # minutes per slot

    business = relationship("Business")

    def __repr__(self):
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        day = days[self.day_of_week] if 0 <= self.day_of_week <= 6 else "?"
        return f"<WorkingHours {day} {'OPEN' if self.is_open else 'CLOSED'} {self.start_time}-{self.end_time}>"


class Appointment(Base):
    __tablename__ = "appointments"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), default=1)
    lead_id = Column(Integer, ForeignKey("leads.id"), nullable=True)  # null = manual/walk-in
    title = Column(String(255), default="Appointment")
    date = Column(String(10), nullable=False)  # "YYYY-MM-DD"
    start_time = Column(String(5), nullable=False)  # "HH:MM"
    end_time = Column(String(5), nullable=False)  # "HH:MM"
    status = Column(String(20), default="confirmed")  # confirmed, cancelled, completed, no_show
    notes = Column(Text, default="")
    booked_by = Column(String(20), default="manual")  # "manual", "ai", "lead"
    reminder_sent = Column(Integer, default=0)  # 0=not sent, 1=sent
    feedback_sent = Column(Integer, default=0)  # 0=not sent, 1=sent
    created_at = Column(DateTime, default=lambda: datetime.utcnow())

    business = relationship("Business")
    lead = relationship("Lead")

    def __repr__(self):
        return f"<Appointment id={self.id} date={self.date} {self.start_time}-{self.end_time} status={self.status!r}>"


class VoiceSettings(Base):
    __tablename__ = "voice_settings"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), unique=True, default=1)

    # Vapi connection
    vapi_api_key = Column(String(500), default="")
    vapi_assistant_id = Column(String(100), default="")
    vapi_phone_id = Column(String(100), default="")
    phone_number = Column(String(20), default="")

    # Assistant config
    agent_name = Column(String(255), default="AI Assistant")
    voice_provider = Column(String(50), default="11labs")  # 11labs, playht, deepgram
    voice_id = Column(String(100), default="")
    language = Column(String(10), default="hi-IN")
    first_message = Column(Text, default="Hello! How can I help you today?")
    system_prompt = Column(Text, default="")

    # Feature toggles
    can_book_appointments = Column(Integer, default=1)
    can_transfer_call = Column(Integer, default=1)

    # Webhook
    webhook_secret = Column(String(100), default="")

    is_active = Column(Integer, default=0)
    updated_at = Column(DateTime, default=lambda: datetime.utcnow(), onupdate=lambda: datetime.utcnow())

    business = relationship("Business")

    def __repr__(self):
        return f"<VoiceSettings business={self.business_id} active={self.is_active} assistant={self.vapi_assistant_id!r}>"


class CallLog(Base):
    __tablename__ = "call_logs"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), default=1)
    lead_id = Column(Integer, ForeignKey("leads.id"), nullable=True)

    # Vapi call data
    vapi_call_id = Column(String(100), default="")
    phone_number = Column(String(20), default="")
    direction = Column(String(10), default="inbound")  # inbound, outbound
    status = Column(String(20), default="queued")  # queued, in-progress, ended, failed

    # Call details
    duration_seconds = Column(Integer, default=0)
    cost = Column(Float, default=0.0)
    recording_url = Column(String(500), default="")
    transcript = Column(Text, default="")
    summary = Column(Text, default="")
    ended_reason = Column(String(50), default="")

    # Actions taken
    appointments_booked = Column(Integer, default=0)

    created_at = Column(DateTime, default=lambda: datetime.utcnow())

    business = relationship("Business")
    lead = relationship("Lead")

    def __repr__(self):
        return f"<CallLog id={self.id} phone={self.phone_number} status={self.status!r} duration={self.duration_seconds}s>"
