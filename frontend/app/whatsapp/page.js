'use client';
import { useState, useEffect, useRef } from 'react';
import { API, safeFetch, formatWhatsAppTime, formatTime } from '../lib/utils';
import { useClient } from '../lib/ClientContext';

export default function WhatsApp() {
  const [activeTab, setActiveTab] = useState('web'); // 'web' | 'settings'
  const [status, setStatus] = useState({ connected: false, state: 'starting', hasQR: false, info: null, error: null, mode: 'qr' });
  const [qrImage, setQrImage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  // Chat section state
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [search, setSearch] = useState('');
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  // Settings state
  const [aiSettings, setAiSettings] = useState(null);
  const [cloudForm, setCloudForm] = useState({ wa_app_id: '', wa_app_secret: '', wa_phone_number_id: '', wa_access_token: '', wa_verify_token: '', wa_business_account_id: '' });
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [webhookStatus, setWebhookStatus] = useState(null);
  const [subscribing, setSubscribing] = useState(false);
  const [customWebhookUrl, setCustomWebhookUrl] = useState('');
  const [syncingChats, setSyncingChats] = useState(false);

  const { bUrl, selectedClientId } = useClient();

  const showToast = (msg, type = 'success') => {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const triggerChatSync = async () => {
    setSyncingChats(true);
    showToast('Syncing recent WhatsApp chats...', 'info');
    const [d, err] = await safeFetch(bUrl('/whatsapp/trigger-sync'), { method: 'POST' });
    setSyncingChats(false);
    if (d?.success || d?.synced_count !== undefined) {
      showToast('Chats synced successfully!', 'success');
      fetchConversations().then(list => {
        if (list.length > 0 && !activeId) setActiveId(list[0].id);
      });
    } else {
      showToast(err || d?.error || 'Chat sync completed', 'success');
      fetchConversations();
    }
  };

  const fetchQR = async () => {
    const [d] = await safeFetch(bUrl('/whatsapp/qr'));
    if (d?.qr) setQrImage(d.qr);
  };

  const checkStatus = async () => {
    const [d] = await safeFetch(bUrl('/whatsapp/status'));
    if (d) {
      setStatus(d);
      if (d.qr) setQrImage(d.qr);
      else if (d.hasQR) fetchQR();
    } else {
      setStatus(s => ({ ...s, connected: false, state: 'disconnected', error: 'Bridge unreachable' }));
    }
    setLoading(false);
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

  const fetchAI = async () => {
    const [d] = await safeFetch(bUrl('/ai-settings'));
    if (d) {
      setAiSettings(d);
      setCloudForm({
        wa_app_id: d.wa_app_id || '', wa_app_secret: d.wa_app_secret || '',
        wa_phone_number_id: d.wa_phone_number_id || '', wa_access_token: d.wa_access_token || '',
        wa_verify_token: d.wa_verify_token || '', wa_business_account_id: d.wa_business_account_id || '',
      });
    }
  };

  // Initial load & Client switch
  useEffect(() => {
    // Reset view to blank state for the selected client
    setStatus({ connected: false, state: 'starting', hasQR: false, info: null, error: null, mode: 'qr' });
    setQrImage(null);
    setActiveId(null);
    setMessages([]);
    setConversations([]);
    setLoading(true);

    checkStatus();
    fetchAI();
    fetchConversations().then(list => {
      if (list.length > 0) setActiveId(list[0].id);
    });
  }, [selectedClientId]);

  // Periodic polling
  useEffect(() => {
    const statusIv = setInterval(checkStatus, 5000);
    const convsIv = setInterval(() => {
      if (status.connected) fetchConversations();
    }, 8000);
    return () => {
      clearInterval(statusIv);
      clearInterval(convsIv);
    };
  }, [status.connected, selectedClientId]);

  // Load messages when activeId changes
  useEffect(() => {
    if (activeId) {
      setLoadingMessages(true);
      fetchMessages(activeId).finally(() => setLoadingMessages(false));
    }
  }, [activeId]);

  // Live polling for active messages
  useEffect(() => {
    if (!activeId || !status.connected) return;
    const iv = setInterval(() => fetchMessages(activeId), 4000);
    return () => clearInterval(iv);
  }, [activeId, status.connected]);

  // Scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const currentMode = aiSettings?.wa_connection_mode || 'qr';

  const updateAISetting = async (updates) => {
    if (!aiSettings) return;
    const newSettings = { ...aiSettings, ...updates };
    const [data, err] = await safeFetch(bUrl('/ai-settings'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings),
    });
    if (data && !err) {
      setAiSettings(newSettings);
      return true;
    }
    showToast('Failed to update settings', 'error');
    return false;
  };

  const switchMode = async (mode) => {
    const ok = await updateAISetting({ wa_connection_mode: mode });
    if (ok) {
      showToast(mode === 'cloud_api' ? 'Switched to Cloud API' : 'Switched to QR Scan', 'success');
      setTestResult(null);
      setTimeout(checkStatus, 1000);
    }
  };

  const saveCloudSettings = async () => {
    setSaving(true);
    const ok = await updateAISetting({ ...cloudForm, wa_connection_mode: 'cloud_api' });
    setSaving(false);
    if (ok) {
      showToast('Cloud API settings saved!', 'success');
      setTimeout(checkStatus, 1000);
    }
  };

  const testCloudConnection = async () => {
    setSaving(true);
    const saveOk = await updateAISetting({ ...cloudForm, wa_connection_mode: 'cloud_api' });
    setSaving(false);
    if (!saveOk) return;

    setTesting(true);
    setTestResult({ loading: true });
    const [d, err] = await safeFetch(bUrl('/whatsapp/cloud/test'), { method: 'POST' });
    setTesting(false);
    if (d) {
      setTestResult(d);
      if (d.success) setTimeout(checkStatus, 1000);
    } else {
      setTestResult({ success: false, error: err || 'Connection test failed', checks: [] });
    }
  };

  const disconnect = async () => {
    if (!confirm('Are you sure you want to disconnect WhatsApp? You will need to scan QR again.')) return;
    const [, err] = await safeFetch(bUrl('/whatsapp/disconnect'), { method: 'POST' });
    if (!err) {
      showToast('Disconnected successfully.', 'success');
      setQrImage(null);
      setActiveId(null);
      setMessages([]);
      checkStatus();
    } else {
      showToast('Disconnect failed', 'error');
    }
  };

  const restart = async () => {
    const [, err] = await safeFetch(bUrl('/whatsapp/restart'), { method: 'POST' });
    if (!err) {
      showToast('Restarting WhatsApp bridge...', 'success');
      setTimeout(checkStatus, 3000);
    } else {
      showToast('Restart failed', 'error');
    }
  };

  const toggleGroupReplies = async () => {
    const v = aiSettings?.group_replies ? 0 : 1;
    const ok = await updateAISetting({ group_replies: v });
    if (ok) showToast(v ? 'Group replies ON' : 'Group replies OFF', 'success');
  };

  const webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/whatsapp/cloud/webhook` : '';

  const checkWebhookStatus = async () => {
    const [d] = await safeFetch(bUrl('/whatsapp/cloud/webhook-status'));
    if (d) setWebhookStatus(d);
  };

  const subscribeWebhook = async () => {
    const url = customWebhookUrl.trim() || webhookUrl;
    if (!url) { showToast('Enter a webhook URL', 'error'); return; }
    if (!url.startsWith('https://')) { showToast('Webhook URL must start with https://', 'error'); return; }
    setSubscribing(true);
    const [d, err] = await safeFetch(bUrl(`/whatsapp/cloud/subscribe?webhook_url=${encodeURIComponent(url)}`), { method: 'POST' });
    setSubscribing(false);
    if (d?.success) {
      showToast('✅ Webhook subscribed! Meta will send messages now.', 'success');
      checkWebhookStatus();
    } else {
      showToast(d?.error || err || 'Subscribe failed', 'error');
    }
  };

  // Manual chat reply
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

  // Toggle AI takeover for active conversation
  const toggleAI = async () => {
    if (!activeId) return;
    const isHandover = activeLead?.lead_status === 'handover';
    const newStatus = isHandover ? 'warm' : 'handover';
    const [data, err] = await safeFetch(`${API}/conversations/${activeId}/lead-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (data?.success) {
      showToast(newStatus === 'handover' ? '👤 AI Paused — You are in manual control' : '🤖 AI Resumed — Bot will reply automatically', 'success');
      fetchConversations();
    } else {
      showToast(err || 'Failed to toggle AI mode', 'error');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendManualReply();
    }
  };

  const activeConv = conversations.find(c => c.id === activeId);
  const activeLead = activeConv?.lead;
  const isHandover = activeLead?.lead_status === 'handover';

  const filteredConversations = conversations.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    const name = (c.lead?.name || '').toLowerCase();
    const phone = (c.lead?.phone_number || '');
    const lastMsg = (c.last_message || '').toLowerCase();
    return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
  });

  const CredField = ({ label, field, placeholder, hint, type = 'text', required = false }) => (
    <div className="form-group" style={{ marginBottom: 14 }}>
      <label className="form-label" style={{ fontSize: 12, fontWeight: 600 }}>{label} {required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
      <input className="form-input" type={type} placeholder={placeholder} value={cloudForm[field]} onChange={e => setCloudForm({ ...cloudForm, [field]: e.target.value })} style={{ fontSize: 13 }} />
      {hint && <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3 }}>{hint}</div>}
    </div>
  );

  if (loading) {
    return <div className="loading"><div className="spinner"></div>Connecting to WhatsApp services...</div>;
  }

  return (
    <div style={{ margin: '-24px -28px', height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column' }}>
      
      {/* ── TOP NAV BAR: TABS & LIVE STATUS ── */}
      <div style={{
        padding: '10px 24px',
        borderBottom: '1px solid var(--border-color)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0
      }}>
        {/* Left: Tab selection */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            onClick={() => setActiveTab('web')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              background: activeTab === 'web' ? 'rgba(16,185,129,0.15)' : 'transparent',
              color: activeTab === 'web' ? 'var(--accent)' : 'var(--text-secondary)',
              border: activeTab === 'web' ? '1px solid rgba(16,185,129,0.3)' : '1px solid transparent',
              transition: 'all 0.2s',
            }}
          >
            <span>💬 WhatsApp Web</span>
            {status.connected && (
              <span style={{ fontSize: 10, background: 'var(--accent)', color: '#000', padding: '1px 6px', borderRadius: 10, fontWeight: 700 }}>
                {conversations.length}
              </span>
            )}
          </div>

          <div
            onClick={() => setActiveTab('settings')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              background: activeTab === 'settings' ? 'rgba(99,102,241,0.15)' : 'transparent',
              color: activeTab === 'settings' ? '#818cf8' : 'var(--text-secondary)',
              border: activeTab === 'settings' ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
              transition: 'all 0.2s',
            }}
          >
            <span>⚙️ Settings & Automation</span>
          </div>
        </div>

        {/* Right: Live Connection Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {status.connected ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', background: 'rgba(16,185,129,0.1)', borderRadius: 20, border: '1px solid rgba(16,185,129,0.3)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 8px var(--success)' }}></span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--success)' }}>
                  {status.info?.pushname || 'Connected'} {status.info?.phone ? `(+${status.info.phone})` : ''}
                </span>
              </div>
              <button
                onClick={disconnect}
                className="btn btn-secondary"
                style={{ fontSize: 11, padding: '4px 10px', color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.3)' }}
                title="Disconnect session"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)' }}></span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)' }}>
                {status.state === 'authenticating' ? 'Authenticating...' : status.state === 'syncing' ? 'Syncing chats...' : 'WhatsApp Offline'}
              </span>
              <button onClick={restart} className="btn btn-secondary" style={{ fontSize: 11, padding: '4px 10px' }}>
                🔄 Restart
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── TAB CONTENT ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* ═══════════════════════════════════════════════════════════
            TAB 1: WHATSAPP WEB LIVE INTERFACE
            ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'web' && (
          <>
            {/* If NOT CONNECTED: Hide chat section completely and show QR connect screen! */}
            {!status.connected ? (
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-primary)',
                padding: 24,
              }}>
                <div className="card" style={{ maxWidth: 520, width: '100%', textAlign: 'center', padding: '36px 32px' }}>
                  <div style={{ fontSize: 44, marginBottom: 12 }}>📱</div>
                  <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Connect WhatsApp Web</h3>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>
                    Scan this QR code with WhatsApp on your phone to link your account. Once connected, your active chats and AI automations will appear here.
                  </p>

                  {/* QR Box with Live State */}
                  <div style={{
                    width: 256,
                    height: 256,
                    margin: '0 auto 20px',
                    borderRadius: 14,
                    border: '2px solid var(--border-color)',
                    background: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                    overflow: 'hidden',
                  }}>
                    {qrImage ? (
                      <img src={qrImage} alt="WhatsApp QR Code" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#333' }}>
                        <div className="spinner" style={{ borderColor: 'rgba(16,185,129,0.3)', borderTopColor: 'var(--accent)' }}></div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#4b5563' }}>
                          {status.state === 'authenticating' ? 'Authenticating with phone...' :
                           status.state === 'syncing' ? `Syncing chats ${status.loading?.percent ? `${status.loading.percent}%` : '...'}` :
                           'Generating QR code...'}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Status Banner */}
                  {status.state === 'authenticating' && (
                    <div style={{ padding: '8px 14px', marginBottom: 16, borderRadius: 8, background: 'rgba(16,185,129,0.1)', color: 'var(--success)', fontSize: 13, fontWeight: 600 }}>
                      ✅ Device scanned! Logging into WhatsApp Web...
                    </div>
                  )}

                  {status.state === 'syncing' && (
                    <div style={{ padding: '8px 14px', marginBottom: 16, borderRadius: 8, background: 'rgba(99,102,241,0.1)', color: '#818cf8', fontSize: 13, fontWeight: 600 }}>
                      ⏳ Loading chats and messages ({status.loading?.percent || 0}%)... Please wait.
                    </div>
                  )}

                  {status.error && (
                    <div style={{ padding: '8px 14px', marginBottom: 16, borderRadius: 8, background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', fontSize: 12 }}>
                      ⚠️ {status.error}
                    </div>
                  )}

                  {/* Instructions */}
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    lineHeight: 1.8,
                    textAlign: 'left',
                    background: 'var(--bg-secondary)',
                    padding: '14px 18px',
                    borderRadius: 8,
                    marginBottom: 20
                  }}>
                    <strong>How to connect:</strong><br />
                    1. Open <strong>WhatsApp</strong> on your phone<br />
                    2. Tap <strong>Menu ⋮</strong> or <strong>Settings ⚙️</strong> → <strong>Linked Devices</strong><br />
                    3. Tap <strong>Link a Device</strong> and point your camera at this QR code
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                    <button className="btn btn-primary" onClick={() => { fetchQR(); checkStatus(); }}>
                      ↻ Refresh QR
                    </button>
                    <button className="btn btn-secondary" onClick={restart}>
                      🔄 Restart Bridge
                    </button>
                    <button className="btn btn-secondary" onClick={() => setActiveTab('settings')}>
                      ⚙️ Setup Cloud API
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* CONNECTED: Full WhatsApp Web Interface */
              <div className="split-pane" style={{ flex: 1 }}>
                
                {/* ── LEFT PANEL: CHATS LIST ── */}
                <div className="split-left" style={{ width: 360, minWidth: 360, background: 'var(--bg-secondary)', borderRight: '1px solid var(--border-color)' }}>
                  {/* Search Header */}
                  <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ position: 'relative', flex: 1 }}>
                        <input
                          className="form-input"
                          placeholder="🔍 Search name, number..."
                          value={search}
                          onChange={e => setSearch(e.target.value)}
                          style={{ fontSize: 12, padding: '9px 12px', borderRadius: 8, background: 'var(--bg-primary)' }}
                        />
                        {search && (
                          <button
                            onClick={() => setSearch('')}
                            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12 }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      <button
                        onClick={triggerChatSync}
                        disabled={syncingChats}
                        className="btn btn-secondary btn-sm"
                        title="Sync recent WhatsApp chats from phone"
                        style={{ padding: '8px 12px', fontSize: 11, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4, height: 36, borderRadius: 8 }}
                      >
                        {syncingChats ? '⏳ Syncing...' : '🔄 Sync'}
                      </button>
                    </div>
                  </div>

                  {/* Conversations Scroll Area */}
                  <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
                    {filteredConversations.length === 0 ? (
                      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                        <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
                        <div>{search ? 'No matching chats found' : 'No WhatsApp conversations yet.'}</div>
                        {!search && (
                          <button
                            onClick={triggerChatSync}
                            disabled={syncingChats}
                            className="btn btn-primary btn-sm"
                            style={{ marginTop: 14, fontSize: 12, padding: '8px 16px', borderRadius: 8 }}
                          >
                            {syncingChats ? '⏳ Syncing chats...' : '🔄 Sync Recent WhatsApp Chats'}
                          </button>
                        )}
                      </div>
                    ) : (
                      filteredConversations.map(conv => {
                        const lead = conv.lead || {};
                        const isA = conv.id === activeId;
                        const isHO = lead.lead_status === 'handover';
                        const lastMsg = conv.last_message || 'No messages yet';
                        const lastTime = conv.last_message_time || conv.created_at;
                        const avatarBg = `hsl(${(lead.name || 'U').charCodeAt(0) * 43 % 360}, 65%, 45%)`;

                        return (
                          <div
                            key={conv.id}
                            onClick={() => setActiveId(conv.id)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '12px 14px',
                              borderRadius: 10,
                              cursor: 'pointer',
                              background: isA ? 'rgba(16,185,129,0.1)' : 'transparent',
                              borderLeft: isA ? '3px solid var(--accent)' : '3px solid transparent',
                              transition: 'all 0.15s ease',
                              marginBottom: 4,
                            }}
                          >
                            {/* Avatar */}
                            <div style={{
                              width: 44,
                              height: 44,
                              borderRadius: '50%',
                              background: avatarBg,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#fff',
                              fontWeight: 700,
                              fontSize: 16,
                              flexShrink: 0,
                              boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
                            }}>
                              {(lead.name || '?')[0].toUpperCase()}
                            </div>

                            {/* Details */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                                <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {lead.name && lead.name !== 'Unknown' ? lead.name : lead.phone_number}
                                </span>
                                <span style={{ fontSize: 11, color: isA ? 'var(--accent)' : 'var(--text-tertiary)', flexShrink: 0 }}>
                                  {formatWhatsAppTime(lastTime)}
                                </span>
                              </div>

                              {/* Phone number */}
                              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 3 }}>
                                {lead.phone_number}
                              </div>

                              {/* Last Message Snippet */}
                              <div style={{
                                fontSize: 12,
                                color: isA ? 'var(--text-primary)' : 'var(--text-secondary)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                              }}>
                                {conv.last_sender_type === 'ai' && <span style={{ color: 'var(--accent)', fontWeight: 600 }}>🤖 AI: </span>}
                                {conv.last_sender_type === 'human' && <span style={{ color: 'var(--warning)', fontWeight: 600 }}>👤 You: </span>}
                                <span>{lastMsg && (lastMsg.startsWith('/9j/') || lastMsg.startsWith('data:image') || (lastMsg.length > 150 && !lastMsg.includes(' '))) ? '📷 [Photo]' : lastMsg}</span>
                              </div>

                              {/* Badges */}
                              <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                                <span className={`lead-badge ${lead.lead_status || 'new'}`} style={{ fontSize: 9, padding: '1px 7px' }}>
                                  <span className="badge-dot" style={{ width: 4, height: 4 }}></span>
                                  {(lead.lead_status || 'new').toUpperCase()}
                                </span>
                                {isHO ? (
                                  <span style={{ fontSize: 9, color: 'var(--warning, #f59e0b)', fontWeight: 700, background: 'rgba(245,158,11,0.15)', padding: '1px 6px', borderRadius: 4 }}>
                                    👤 MANUAL
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 700, background: 'rgba(16,185,129,0.15)', padding: '1px 6px', borderRadius: 4 }}>
                                    🤖 AI ACTIVE
                                  </span>
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
                <div className="split-right" style={{ background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column' }}>
                  {activeLead ? (
                    <>
                      {/* Active Chat Header */}
                      <div style={{
                        padding: '12px 20px',
                        borderBottom: '1px solid var(--border-color)',
                        background: 'var(--bg-secondary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexShrink: 0,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{
                            width: 42,
                            height: 42,
                            borderRadius: '50%',
                            background: `hsl(${(activeLead.name || 'U').charCodeAt(0) * 43 % 360}, 65%, 45%)`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#fff',
                            fontWeight: 700,
                            fontSize: 16,
                          }}>
                            {(activeLead.name || '?')[0].toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 14.5 }}>
                              {activeLead.name || 'Unknown Contact'}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span>📞 {activeLead.phone_number}</span>
                              <span>•</span>
                              <span style={{ color: 'var(--success)' }}>🟢 WhatsApp Connected</span>
                            </div>
                          </div>
                        </div>

                        {/* Controls */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span className={`lead-badge ${activeLead.lead_status}`}>
                            <span className="badge-dot"></span>
                            {(activeLead.lead_status || 'new').toUpperCase()} {activeLead.lead_score ? `• ${activeLead.lead_score} pts` : ''}
                          </span>
                          <button
                            onClick={toggleAI}
                            className={`btn ${isHandover ? 'btn-primary' : 'btn-danger'}`}
                            style={{ fontSize: 11, padding: '6px 14px', fontWeight: 600 }}
                          >
                            {isHandover ? '🤖 Resume AI' : '👤 Take Over'}
                          </button>
                        </div>
                      </div>

                      {/* Handover Notice Banner */}
                      {isHandover && (
                        <div style={{
                          padding: '8px 20px',
                          background: 'rgba(251,191,36,0.1)',
                          borderBottom: '1px solid rgba(251,191,36,0.25)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexShrink: 0
                        }}>
                          <div style={{ fontSize: 12, color: 'var(--warning, #f59e0b)', fontWeight: 600 }}>
                            👤 You are currently in manual control — AI auto-replies are paused for this customer.
                          </div>
                          <button
                            onClick={toggleAI}
                            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, fontWeight: 700, textDecoration: 'underline' }}
                          >
                            Resume AI
                          </button>
                        </div>
                      )}

                      {/* Chat Messages Body */}
                      <div style={{
                        flex: 1,
                        overflowY: 'auto',
                        padding: '20px 24px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        backgroundImage: 'radial-gradient(rgba(99,102,241,0.04) 1px, transparent 1px)',
                        backgroundSize: '24px 24px',
                      }}>
                        {loadingMessages ? (
                          <div className="loading" style={{ margin: 'auto' }}><div className="spinner"></div>Loading messages...</div>
                        ) : messages.length === 0 ? (
                          <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--text-tertiary)', fontSize: 13 }}>
                            No messages exchanged yet with this contact.
                          </div>
                        ) : (
                          messages.map((msg, index) => {
                            const isAI = msg.sender_type === 'ai';
                            const isHuman = msg.sender_type === 'human';
                            const isOut = isAI || isHuman;

                            return (
                              <div
                                key={msg.id || index}
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: isOut ? 'flex-end' : 'flex-start',
                                  marginBottom: 4,
                                }}
                              >
                                {/* Sender Tag */}
                                {isAI && (
                                  <div style={{ fontSize: 10, color: 'var(--accent)', marginBottom: 3, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    🤖 FlowBot AI
                                  </div>
                                )}
                                {isHuman && (
                                  <div style={{ fontSize: 10, color: 'var(--warning)', marginBottom: 3, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    👤 Agent (Manual)
                                  </div>
                                )}

                                {/* Message Bubble */}
                                <div style={{
                                  maxWidth: '70%',
                                  padding: '10px 16px',
                                  borderRadius: isOut ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                                  background: isAI
                                    ? 'linear-gradient(135deg, #059669, #10b981)'
                                    : isHuman
                                    ? 'linear-gradient(135deg, #d97706, #f59e0b)'
                                    : 'var(--bg-card)',
                                  color: isOut ? '#ffffff' : 'var(--text-primary)',
                                  fontSize: 13.5,
                                  lineHeight: 1.5,
                                  border: isOut ? 'none' : '1px solid var(--border-color)',
                                  boxShadow: isOut ? '0 2px 8px rgba(16,185,129,0.2)' : '0 2px 6px rgba(0,0,0,0.1)',
                                  wordBreak: 'break-word',
                                  whiteSpace: 'pre-wrap',
                                }}>
                                  {msg.message_text?.startsWith('data:image/') || (msg.message_text?.startsWith('/9j/') && msg.message_text.length > 100) ? (
                                  <img 
                                    src={msg.message_text.startsWith('data:image/') ? msg.message_text : `data:image/jpeg;base64,${msg.message_text}`} 
                                    alt="WhatsApp Media" 
                                    style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8, display: 'block' }} 
                                  />
                                ) : (
                                  msg.message_text
                                )}
                                </div>

                                {/* Timestamp + Delivery indicator */}
                                <div style={{
                                  fontSize: 10,
                                  color: 'var(--text-tertiary)',
                                  marginTop: 3,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}>
                                  <span>{formatTime(msg.created_at)}</span>
                                  {isOut && <span style={{ color: 'var(--accent)', fontSize: 12 }}>✓✓</span>}
                                </div>
                              </div>
                            );
                          })
                        )}
                        <div ref={chatEndRef}></div>
                      </div>

                      {/* Reply Input Bar */}
                      <div style={{
                        padding: '14px 20px',
                        borderTop: '1px solid var(--border-color)',
                        background: 'var(--bg-secondary)',
                        flexShrink: 0
                      }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                          <textarea
                            ref={inputRef}
                            className="form-input"
                            placeholder="Type a message... (Press Enter to send, Shift+Enter for new line)"
                            value={replyText}
                            onChange={e => setReplyText(e.target.value)}
                            onKeyDown={handleKeyDown}
                            rows={1}
                            style={{
                              flex: 1,
                              resize: 'none',
                              minHeight: 44,
                              maxHeight: 120,
                              fontFamily: 'inherit',
                              fontSize: 13,
                              padding: '10px 14px',
                            }}
                          />
                          <button
                            className="btn btn-primary"
                            onClick={sendManualReply}
                            disabled={sending || !replyText.trim()}
                            style={{ height: 44, minWidth: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          >
                            {sending ? <div className="spinner" style={{ width: 14, height: 14 }}></div> : '📩 Send'}
                          </button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8 }}>
                          {isHandover
                            ? '👤 Replying manually. Click "Resume AI" above whenever you want the bot to take over.'
                            : '⚡ Sending a manual reply will automatically pause the AI bot for this contact.'}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state" style={{ margin: 'auto' }}>
                      <div className="empty-icon">💬</div>
                      <h4 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Select a Conversation</h4>
                      <p>Pick a chat from the left panel to view WhatsApp messages and reply directly.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* ═══════════════════════════════════════════════════════════
            TAB 2: SETTINGS & AUTOMATION
            ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'settings' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>WhatsApp & AI Settings</h2>
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
              Configure AI reply behaviors, connection mode, and response filters.
            </p>

            {/* Connection Mode Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
              <div
                onClick={() => switchMode('qr')}
                style={{
                  padding: '18px',
                  borderRadius: 12,
                  border: `2px solid ${currentMode === 'qr' ? 'var(--accent)' : 'var(--border-color)'}`,
                  background: currentMode === 'qr' ? 'rgba(16,185,129,0.08)' : 'var(--bg-secondary)',
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 32, marginBottom: 6 }}>📱</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: currentMode === 'qr' ? 'var(--accent)' : 'var(--text-primary)' }}>
                  WhatsApp Web (QR Scan)
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Connect using any phone via QR Code
                </div>
                {currentMode === 'qr' && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>✓ Active Mode</div>}
              </div>

              <div
                onClick={() => switchMode('cloud_api')}
                style={{
                  padding: '18px',
                  borderRadius: 12,
                  border: `2px solid ${currentMode === 'cloud_api' ? 'var(--accent)' : 'var(--border-color)'}`,
                  background: currentMode === 'cloud_api' ? 'rgba(16,185,129,0.08)' : 'var(--bg-secondary)',
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 32, marginBottom: 6 }}>☁️</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: currentMode === 'cloud_api' ? 'var(--accent)' : 'var(--text-primary)' }}>
                  Meta Cloud API (Official)
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Official Meta WhatsApp Business Cloud API
                </div>
                {currentMode === 'cloud_api' && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>✓ Active Mode</div>}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* Left Column: Cloud API Form / QR Control */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {currentMode === 'cloud_api' ? (
                  <div className="card">
                    <div className="card-header">Meta Cloud API Credentials</div>
                    <CredField label="Access Token" field="wa_access_token" type="password" placeholder="EAAxxxxxxx..." required />
                    <CredField label="App ID" field="wa_app_id" placeholder="e.g. 1234567890123" required />
                    <CredField label="App Secret" field="wa_app_secret" type="password" placeholder="e.g. abc123def456..." required />
                    <CredField label="Phone Number ID" field="wa_phone_number_id" placeholder="e.g. 1234567890" required />
                    <CredField label="WhatsApp Business Account ID" field="wa_business_account_id" placeholder="e.g. 1234567890" required />
                    <CredField label="Webhook Verify Token" field="wa_verify_token" placeholder="Any secret string" />

                    <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                      <button className="btn btn-primary" onClick={testCloudConnection} disabled={testing || saving} style={{ flex: 1 }}>
                        {testing ? 'Testing...' : 'Save & Test'}
                      </button>
                      <button className="btn btn-secondary" onClick={saveCloudSettings} disabled={saving}>
                        Save Only
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="card">
                    <div className="card-header">WhatsApp Web Connection Status</div>
                    <div style={{ padding: '14px 0', textAlign: 'center' }}>
                      <div style={{ fontSize: 36, marginBottom: 8 }}>{status.connected ? '✅' : '🔴'}</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: status.connected ? 'var(--success)' : 'var(--danger)', marginBottom: 4 }}>
                        {status.connected ? 'WhatsApp Web Connected' : 'WhatsApp Web Offline'}
                      </div>
                      {status.info && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          User: <strong>{status.info.pushname}</strong> {status.info.phone ? `(+${status.info.phone})` : ''}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 10 }}>
                      <button className="btn btn-secondary" onClick={restart}>🔄 Restart Bridge</button>
                      <button className="btn btn-secondary" onClick={checkStatus}>↻ Refresh Status</button>
                      {status.connected && (
                        <button className="btn btn-danger" onClick={disconnect}>Disconnect</button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column: AI Automation Rules */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* Group replies & Saved Contacts */}
                <div className="card">
                  <div className="card-header">AI Reply Filters</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>Reply to Group Messages</div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>Allow AI bot to respond in WhatsApp groups</div>
                    </div>
                    <div
                      onClick={toggleGroupReplies}
                      style={{
                        width: 44, height: 24, borderRadius: 12,
                        background: aiSettings?.group_replies ? 'var(--accent)' : 'var(--border-color)',
                        cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0
                      }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: '50%', background: '#fff',
                        position: 'absolute', top: 3, left: aiSettings?.group_replies ? 23 : 3,
                        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                      }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: aiSettings?.group_replies ? 'var(--success)' : 'var(--text-tertiary)', marginTop: 6, fontWeight: 600, paddingBottom: 14, borderBottom: '1px solid var(--border-color)' }}>
                    {aiSettings?.group_replies ? '🟢 Group replies enabled' : '⚫ Group replies disabled'}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0 6px' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>Reply to Saved Contacts</div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>When OFF, AI only replies to new/unsaved numbers</div>
                    </div>
                    <div
                      onClick={async () => {
                        const v = aiSettings?.reply_to_contacts ? 0 : 1;
                        const ok = await updateAISetting({ reply_to_contacts: v });
                        if (ok) showToast(v ? 'Replying to all numbers' : 'Only replying to new numbers', 'success');
                      }}
                      style={{
                        width: 44, height: 24, borderRadius: 12,
                        background: aiSettings?.reply_to_contacts ? 'var(--accent)' : 'var(--border-color)',
                        cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0
                      }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: '50%', background: '#fff',
                        position: 'absolute', top: 3, left: aiSettings?.reply_to_contacts ? 23 : 3,
                        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                      }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: aiSettings?.reply_to_contacts ? 'var(--success)' : 'var(--warning)', marginTop: 6, fontWeight: 600 }}>
                    {aiSettings?.reply_to_contacts ? '🟢 Replying to everyone' : '🟡 Only replying to new/unsaved numbers'}
                  </div>
                </div>

                {/* Reply Delay */}
                <div className="card">
                  <div className="card-header">Human-Like Reply Delay</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
                    Adds a delay before sending replies to look authentic and avoid spam detection.
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {[0, 3, 5, 10, 15, 30].map(s => (
                      <div
                        key={s}
                        onClick={async () => {
                          const ok = await updateAISetting({ reply_delay: s });
                          if (ok) showToast(`Delay set to ${s}s`, 'success');
                        }}
                        style={{
                          padding: '7px 14px',
                          borderRadius: 8,
                          border: `2px solid ${(aiSettings?.reply_delay || 0) === s ? 'var(--accent)' : 'var(--border-color)'}`,
                          background: (aiSettings?.reply_delay || 0) === s ? 'rgba(16,185,129,0.1)' : 'var(--bg-primary)',
                          color: (aiSettings?.reply_delay || 0) === s ? 'var(--accent)' : 'var(--text-secondary)',
                          cursor: 'pointer', fontSize: 12, fontWeight: 600, transition: 'all 0.2s'
                        }}
                      >
                        {s === 0 ? 'Instant' : `${s}s`}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Auto Handover */}
                <div className="card">
                  <div className="card-header">Auto Handover to Human</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>Limit AI Messages Per Contact</div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>Pause AI bot after a set message count for human takeover</div>
                    </div>
                    <div
                      onClick={async () => {
                        const v = aiSettings?.auto_handover ? 0 : 1;
                        const ok = await updateAISetting({ auto_handover: v });
                        if (ok) showToast(v ? 'Handover ON' : 'Handover OFF', 'success');
                      }}
                      style={{
                        width: 44, height: 24, borderRadius: 12,
                        background: aiSettings?.auto_handover ? 'var(--accent)' : 'var(--border-color)',
                        cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0
                      }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: '50%', background: '#fff',
                        position: 'absolute', top: 3, left: aiSettings?.auto_handover ? 23 : 3,
                        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                      }} />
                    </div>
                  </div>
                  {aiSettings?.auto_handover ? (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>
                      <label className="form-label" style={{ fontSize: 12 }}>Hand over after how many bot replies?</label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                        <input
                          className="form-input"
                          type="number"
                          min="1"
                          max="100"
                          value={aiSettings?.handover_after || 10}
                          onChange={e => setAiSettings({ ...aiSettings, handover_after: parseInt(e.target.value) || 10 })}
                          style={{ width: 80, textAlign: 'center', fontSize: 13, fontWeight: 700 }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>replies</span>
                        <button
                          className="btn btn-primary"
                          style={{ fontSize: 11, padding: '6px 14px' }}
                          onClick={async () => {
                            const ok = await updateAISetting({ handover_after: aiSettings?.handover_after || 10 });
                            if (ok) showToast(`Handover set after ${aiSettings?.handover_after || 10} replies`, 'success');
                          }}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className={`toast toast-${toast.type}`} style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000 }}>
          {toast.type === 'success' ? '✅' : '❌'} {toast.message}
        </div>
      )}
    </div>
  );
}
