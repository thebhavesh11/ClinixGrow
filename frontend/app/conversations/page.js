'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { API, safeFetch, formatWhatsAppTime, formatTime } from '../lib/utils';
import { useClient } from '../lib/ClientContext';
import DemoChat from '../components/DemoChat';

export default function Conversations() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null);
  const [showDemo, setShowDemo] = useState(false);
  const [waConnected, setWaConnected] = useState(true);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);
  const { bUrl, selectedClientId } = useClient();

  const showToast = (msg, type = 'success') => {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const checkWhatsApp = async () => {
    const [d] = await safeFetch(bUrl('/whatsapp/status'));
    if (d) setWaConnected(d.connected);
  };

  const fetchConversations = async () => {
    const [d] = await safeFetch(bUrl('/conversations'));
    const list = Array.isArray(d) ? d : [];
    setConversations(list);
    return list;
  };

  const fetchMessages = async (id) => {
    if (!id) return;
    const [d] = await safeFetch(`${API}/conversations/${id}/messages`);
    setMessages(Array.isArray(d) ? d : []);
  };

  useEffect(() => {
    setActiveId(null);
    setMessages([]);
    checkWhatsApp();
    fetchConversations().then(list => {
      if (list.length > 0) setActiveId(list[0].id);
    }).finally(() => setLoading(false));
  }, [selectedClientId]);

  useEffect(() => {
    if (activeId) fetchMessages(activeId);
  }, [activeId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-refresh messages every 4 seconds for active conversation
  useEffect(() => {
    if (!activeId) return;
    const iv = setInterval(() => fetchMessages(activeId), 4000);
    return () => clearInterval(iv);
  }, [activeId]);

  // Auto-refresh conversations list every 8 seconds
  useEffect(() => {
    const iv = setInterval(() => {
      fetchConversations();
      checkWhatsApp();
    }, 8000);
    return () => clearInterval(iv);
  }, [selectedClientId]);

  const activeConv = conversations.find(c => c.id === activeId);
  const activeLead = activeConv?.lead;
  const isHandover = activeLead?.lead_status === 'handover';

  const filtered = conversations.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    const name = (c.lead?.name || '').toLowerCase();
    const phone = (c.lead?.phone_number || '');
    const lastMsg = (c.last_message || '').toLowerCase();
    return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
  });

  const sendManualReply = async () => {
    if (!replyText.trim() || !activeId || sending) return;
    setSending(true);
    const [data, err] = await safeFetch(`${API}/conversations/${activeId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: replyText.trim() }),
    });
    setSending(false);
    if (data?.success) {
      showToast('Message sent! AI paused for this contact.', 'success');
      setReplyText('');
      fetchMessages(activeId);
      fetchConversations();
    } else {
      showToast(data?.error || err || 'Failed to send message', 'error');
      fetchMessages(activeId);
    }
  };

  const toggleAI = async () => {
    if (!activeId) return;
    const newStatus = isHandover ? 'warm' : 'handover';
    const [data, err] = await safeFetch(`${API}/conversations/${activeId}/lead-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (data?.success) {
      showToast(newStatus === 'handover' ? '👤 AI paused — you are in manual control' : '🤖 AI resumed — bot will reply automatically', 'success');
      fetchConversations();
    } else {
      showToast(err || 'Failed', 'error');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendManualReply();
    }
  };

  if (loading) {
    return <div className="loading"><div className="spinner"></div>Loading conversations...</div>;
  }

  return (
    <div style={{ margin: '-24px -28px', height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column' }}>
      
      {/* Offline Alert if WhatsApp is Disconnected */}
      {!waConnected && (
        <div style={{
          padding: '8px 24px',
          background: 'rgba(239,68,68,0.12)',
          borderBottom: '1px solid rgba(239,68,68,0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0
        }}>
          <div style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>⚠️</span> WhatsApp is currently offline. Connect via QR code to resume receiving and sending messages.
          </div>
          <Link href="/whatsapp" className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }}>
            📱 Connect WhatsApp
          </Link>
        </div>
      )}

      <div className="split-pane" style={{ flex: 1 }}>
        {/* ── LEFT PANEL: CONVERSATION LIST ── */}
        <div className="split-left" style={{ width: 360, minWidth: 360, background: 'var(--bg-secondary)', borderRight: '1px solid var(--border-color)' }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Conversations</h2>
              <button className="demo-chat-trigger" onClick={() => setShowDemo(true)}>🧪 Test AI</button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 12 }}>
              Active WhatsApp threads managed by FlowBot
            </p>
            <input
              className="form-input"
              placeholder="🔍 Search name, phone, message..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ fontSize: 12, padding: '8px 12px', background: 'var(--bg-primary)' }}
            />
          </div>

          <div style={{ padding: '6px 8px', flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                No conversations found
              </div>
            ) : (
              filtered.map(conv => {
                const lead = conv.lead || {};
                const isA = conv.id === activeId;
                const isHO = lead.lead_status === 'handover';
                const lastMsg = conv.last_message || 'No messages yet';
                const lastTime = conv.last_message_time || conv.created_at;

                return (
                  <div
                    key={conv.id}
                    onClick={() => setActiveId(conv.id)}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: '12px',
                      borderRadius: 10,
                      cursor: 'pointer',
                      background: isA ? 'rgba(16,185,129,0.1)' : 'transparent',
                      borderLeft: isA ? '3px solid var(--accent)' : '3px solid transparent',
                      transition: 'all 0.15s',
                      marginBottom: 3,
                    }}
                  >
                    <div style={{
                      width: 40,
                      height: 40,
                      borderRadius: '50%',
                      background: `hsl(${(lead.name || 'U').charCodeAt(0) * 37 % 360},60%,45%)`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'white',
                      fontWeight: 700,
                      fontSize: 15,
                      flexShrink: 0
                    }}>
                      {(lead.name || '?')[0].toUpperCase()}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                        <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {lead.name && lead.name !== 'Unknown' ? lead.name : lead.phone_number}
                        </span>
                        <span style={{ fontSize: 10.5, color: isA ? 'var(--accent)' : 'var(--text-tertiary)', flexShrink: 0 }}>
                          {formatWhatsAppTime(lastTime)}
                        </span>
                      </div>

                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
                        {lead.phone_number}
                      </div>

                      {/* Last Message Preview */}
                      <div style={{
                        fontSize: 11.5,
                        color: isA ? 'var(--text-primary)' : 'var(--text-secondary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginBottom: 4,
                      }}>
                        {conv.last_sender_type === 'ai' && <span style={{ color: 'var(--accent)', fontWeight: 600 }}>🤖 AI: </span>}
                        {conv.last_sender_type === 'human' && <span style={{ color: 'var(--warning)', fontWeight: 600 }}>👤 You: </span>}
                        <span>{lastMsg}</span>
                      </div>

                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span className={`lead-badge ${lead.lead_status || 'new'}`} style={{ fontSize: 9, padding: '1px 7px' }}>
                          <span className="badge-dot" style={{ width: 4, height: 4 }}></span>
                          {(lead.lead_status || 'new').toUpperCase()}
                        </span>
                        {isHO ? (
                          <span style={{ fontSize: 9, color: 'var(--warning, #f59e0b)', fontWeight: 700 }}>👤 MANUAL</span>
                        ) : (
                          <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 700 }}>🤖 BOT</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL: ACTIVE CHAT THREAD ── */}
        <div className="split-right" style={{ background: 'var(--bg-primary)' }}>
          {activeLead ? (
            <>
              {/* Chat Header */}
              <div style={{
                padding: '14px 20px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'var(--bg-secondary)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 38,
                    height: 38,
                    borderRadius: '50%',
                    background: `hsl(${(activeLead.name || 'U').charCodeAt(0) * 37 % 360},60%,45%)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontWeight: 700,
                    fontSize: 16
                  }}>
                    {(activeLead.name || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{activeLead.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{activeLead.phone_number}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`lead-badge ${activeLead.lead_status}`}>
                    <span className="badge-dot"></span>
                    {(activeLead.lead_status || 'new').toUpperCase()} — {activeLead.lead_score} pts
                  </span>
                  <button
                    onClick={toggleAI}
                    className={`btn ${isHandover ? 'btn-primary' : 'btn-danger'}`}
                    style={{ fontSize: 11, padding: '6px 14px' }}
                  >
                    {isHandover ? '🤖 Resume AI' : '👤 Take Over'}
                  </button>
                </div>
              </div>

              {/* Handover Banner */}
              {isHandover && (
                <div style={{
                  padding: '8px 20px',
                  background: 'rgba(251,191,36,0.1)',
                  borderBottom: '1px solid rgba(251,191,36,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}>
                  <div style={{ fontSize: 12, color: 'var(--warning, #f59e0b)', fontWeight: 600 }}>
                    👤 You are in control — AI auto-replies are paused for this contact
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Click "Resume AI" to let the bot reply again</div>
                </div>
              )}

              {/* Messages Thread */}
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {messages.map((msg, idx) => {
                  const isAI = msg.sender_type === 'ai';
                  const isHuman = msg.sender_type === 'human';
                  const isOut = isAI || isHuman;

                  return (
                    <div key={msg.id || idx} style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', alignItems: isOut ? 'flex-end' : 'flex-start' }}>
                      {isAI && <div style={{ fontSize: 10, color: 'var(--accent)', marginBottom: 3, fontWeight: 600 }}>🤖 AI Agent</div>}
                      {isHuman && <div style={{ fontSize: 10, color: 'var(--warning, #f59e0b)', marginBottom: 3, fontWeight: 600 }}>👤 You (Manual)</div>}

                      <div style={{
                        maxWidth: '75%',
                        padding: '10px 16px',
                        borderRadius: isOut ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                        background: isAI ? 'var(--accent)' : isHuman ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'var(--bg-card)',
                        color: isOut ? 'white' : 'var(--text-primary)',
                        fontSize: 13,
                        lineHeight: 1.5,
                        border: isOut ? 'none' : '1px solid var(--border-color)',
                        wordBreak: 'break-word',
                        whiteSpace: 'pre-wrap',
                      }}>
                        {msg.message_text}
                      </div>

                      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>{formatTime(msg.created_at)}</span>
                        {isOut && <span style={{ color: 'var(--accent)' }}>✓✓</span>}
                      </div>
                    </div>
                  );
                })}
                <div ref={chatEndRef}></div>
              </div>

              {/* Reply Input */}
              <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <textarea
                    ref={inputRef}
                    className="form-input"
                    placeholder="Type your reply... (Enter to send, Shift+Enter for new line)"
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    style={{ flex: 1, resize: 'none', minHeight: 40, maxHeight: 120, fontFamily: 'inherit' }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={sendManualReply}
                    disabled={sending || !replyText.trim()}
                    style={{ height: 40, minWidth: 80 }}
                  >
                    {sending ? '...' : '📩 Send'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8 }}>
                  {isHandover
                    ? '👤 You are replying manually — AI is paused for this contact'
                    : '⚡ Sending a manual reply will pause AI for this contact'}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ margin: 'auto' }}>
              <div className="empty-icon">💬</div>
              <p>Select a conversation to view the chat thread</p>
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className={`toast toast-${toast.type}`} style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000 }}>
          {toast.type === 'success' ? '✅' : '❌'} {toast.message}
        </div>
      )}
      {showDemo && <DemoChat onClose={() => setShowDemo(false)} />}
    </div>
  );
}
