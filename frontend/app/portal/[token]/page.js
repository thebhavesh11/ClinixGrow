'use client';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { API, safeFetch, timeAgo, scoreColor, formatWhatsAppTime } from '../../lib/utils';

export default function ClientPortal() {
  const params = useParams();
  const token = params?.token;

  // Verification & Auth states
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [clientInfo, setClientInfo] = useState(null);

  // Portal Data states
  const [activeTab, setActiveTab] = useState('leads'); // 'leads' | 'chat' | 'appointments' | 'trends'
  const [overview, setOverview] = useState(null);
  const [leads, setLeads] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [searchLead, setSearchLead] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  // Chat Viewer state
  const [selectedLead, setSelectedLead] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [loadingChat, setLoadingChat] = useState(false);
  const chatBottomRef = useRef(null);

  const [toast, setToast] = useState(null);
  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Helper for authorized headers
  const getHeaders = () => {
    const headers = {};
    if (pin) headers['X-Portal-PIN'] = pin;
    return headers;
  };

  // 1. Initial Verification
  useEffect(() => {
    if (!token) return;
    verifyToken();
  }, [token]);

  async function verifyToken() {
    setLoading(true);
    const [data, err] = await safeFetch(`${API}/portal/verify/${token}`);
    setLoading(false);

    if (err || !data?.valid) {
      setVerified(false);
      return;
    }

    setVerified(true);
    setClientInfo(data);

    // Check if session PIN is already stored
    const savedPin = typeof window !== 'undefined' ? sessionStorage.getItem(`portal_pin_${token}`) : null;
    if (data.pin_required) {
      if (savedPin) {
        setPin(savedPin);
        loadPortalData(savedPin);
      } else {
        setPinRequired(true);
      }
    } else {
      loadPortalData(null);
    }
  }

  async function handlePinSubmit(e) {
    if (e) e.preventDefault();
    setPinError('');
    if (!pinInput.trim()) {
      setPinError('Please enter your 4-digit PIN');
      return;
    }

    const [data, err] = await safeFetch(`${API}/portal/auth/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pinInput.trim() }),
    });

    if (err || !data?.authenticated) {
      setPinError('Incorrect PIN. Please try again.');
      return;
    }

    const validPin = pinInput.trim();
    setPin(validPin);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(`portal_pin_${token}`, validPin);
    }
    setPinRequired(false);
    loadPortalData(validPin);
  }

  // 2. Load Portal Data
  async function loadPortalData(currentPin = pin) {
    const headers = {};
    if (currentPin) headers['X-Portal-PIN'] = currentPin;

    const [ov] = await safeFetch(`${API}/portal/${token}/overview`, { headers });
    const [ld] = await safeFetch(`${API}/portal/${token}/leads`, { headers });
    const [ap] = await safeFetch(`${API}/portal/${token}/appointments`, { headers });

    if (ov) setOverview(ov);
    if (Array.isArray(ld)) setLeads(ld);
    if (Array.isArray(ap)) setAppointments(ap);
  }

  // Polling every 15s when authenticated
  useEffect(() => {
    if (!verified || pinRequired || !token) return;
    const iv = setInterval(() => {
      loadPortalData();
    }, 15000);
    return () => clearInterval(iv);
  }, [verified, pinRequired, token, pin]);

  // Load chat for selected lead
  async function openLeadChat(lead) {
    setSelectedLead(lead);
    setLoadingChat(true);
    const headers = getHeaders();
    const [data] = await safeFetch(`${API}/portal/${token}/leads/${lead.id}/conversation`, { headers });
    setLoadingChat(false);
    setChatMessages(data?.messages || []);
    setTimeout(() => {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  // Download leads CSV
  function downloadLeadsCSV() {
    const url = `${API}/portal/${token}/export-leads`;
    window.open(url, '_blank');
    showToast('Exporting leads to CSV...', 'success');
  }

  // Filtered leads
  const filteredLeads = leads.filter(l => {
    const matchesStatus = filterStatus === 'all' || l.lead_status === filterStatus;
    const matchesSearch = !searchLead.trim() ||
      l.name.toLowerCase().includes(searchLead.toLowerCase()) ||
      l.phone_number.includes(searchLead.trim());
    return matchesStatus && matchesSearch;
  });

  // ── Render: Invalid Token Screen ──
  if (!loading && !verified) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#090d16',
        color: '#fff',
        padding: 20,
      }}>
        <div style={{
          maxWidth: 440,
          width: '100%',
          textAlign: 'center',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '40px 24px',
          backdropFilter: 'blur(10px)',
        }}>
          <div style={{ fontSize: 50, marginBottom: 16 }}>🔒</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Access Denied</h2>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.6, marginBottom: 24 }}>
            This portal link is invalid, expired, or has been revoked. Please ask your automation service provider for an updated link.
          </p>
        </div>
      </div>
    );
  }

  // ── Render: PIN Security Screen ──
  if (pinRequired) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#090d16',
        color: '#fff',
        padding: 20,
      }}>
        <div style={{
          maxWidth: 400,
          width: '100%',
          textAlign: 'center',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '40px 28px',
          backdropFilter: 'blur(10px)',
        }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>🛡️</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{clientInfo?.business_name || 'Client Portal'}</h2>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 24 }}>
            This portal is protected with a security PIN. Enter your PIN to access your automation dashboard.
          </p>

          <form onSubmit={handlePinSubmit}>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={10}
              className="form-input"
              style={{
                fontSize: 24,
                letterSpacing: 8,
                textAlign: 'center',
                padding: '12px 16px',
                marginBottom: 16,
                background: 'rgba(255,255,255,0.06)',
                borderColor: pinError ? 'var(--danger)' : 'rgba(255,255,255,0.15)',
              }}
              placeholder="••••"
              value={pinInput}
              onChange={e => setPinInput(e.target.value)}
              autoFocus
            />

            {pinError && (
              <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 14 }}>
                {pinError}
              </div>
            )}

            <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: '12px' }}>
              Unlock Dashboard →
            </button>
          </form>
        </div>
      </div>
    );
  }

  const s = overview?.stats || {};
  const biz = overview?.business || clientInfo || {};
  const trends = overview?.daily_trends || [];

  return (
    <div className="portal-page-container">
      {/* ── TOP CLIENT HEADER ── */}
      <header className="portal-header">
        <div className="portal-header-inner">
          {/* Left: Branding & Status */}
          <div className="portal-header-brand">
            <div className="portal-brand-avatar">
              {biz.name ? biz.name.slice(0, 2).toUpperCase() : '⚡'}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 17, fontWeight: 800, letterSpacing: -0.3, margin: 0 }}>
                  {biz.name || 'Client Dashboard'}
                </h1>
                <span style={{ fontSize: 10, background: 'rgba(99,102,241,0.2)', color: '#818cf8', padding: '2px 8px', borderRadius: 12, fontWeight: 700 }}>
                  LIVE PORTAL
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {biz.industry && <span>{biz.industry}</span>}
                {biz.location && <span>• {biz.location}</span>}
              </div>
            </div>
          </div>

          {/* Right: Live Connection Indicator & Quick Actions */}
          <div className="portal-header-actions">
            <div
              className="portal-connection-pill"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                borderRadius: 20,
                background: s.whatsapp_connected ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
                border: `1px solid ${s.whatsapp_connected ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: s.whatsapp_connected ? '#10b981' : '#ef4444',
                boxShadow: s.whatsapp_connected ? '0 0 10px #10b981' : 'none',
                flexShrink: 0,
              }}></span>
              <span style={{ fontSize: 12, fontWeight: 600, color: s.whatsapp_connected ? '#10b981' : '#ef4444' }}>
                {s.whatsapp_connected ? (s.whatsapp_phone ? `AI Active • +${s.whatsapp_phone}` : 'AI Active • Online') : 'Connecting...'}
              </span>
            </div>

            <button
              onClick={downloadLeadsCSV}
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
              title="Download all customer inquiries to CSV"
            >
              <span>📥 Export</span>
            </button>

            <button
              onClick={() => { loadPortalData(); showToast('Refreshed live data', 'success'); }}
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: '7px 12px', flexShrink: 0 }}
              title="Refresh live data"
            >
              ↻
            </button>
          </div>
        </div>
      </header>

      {/* ── MAIN CONTENT CONTAINER ── */}
      <main className="portal-main">
        {/* 1. TOP METRIC CARDS */}
        <div className="portal-metrics-grid">
          <div className="portal-stat-card" style={{ borderLeft: '4px solid #6366f1' }}>
            <div className="portal-stat-label">Total Inquiries</div>
            <div className="portal-stat-value" style={{ color: '#fff' }}>{s.total_leads || 0}</div>
            <div className="portal-stat-sub" style={{ color: 'var(--success)' }}>+{s.today_leads || 0} today</div>
          </div>

          <div className="portal-stat-card" style={{ borderLeft: '4px solid #ef4444' }}>
            <div className="portal-stat-label">🔥 Hot Leads</div>
            <div className="portal-stat-value" style={{ color: '#ef4444' }}>{s.hot_leads || 0}</div>
            <div className="portal-stat-sub">High conversion</div>
          </div>

          <div className="portal-stat-card" style={{ borderLeft: '4px solid #f59e0b' }}>
            <div className="portal-stat-label">🟡 Warm Leads</div>
            <div className="portal-stat-value" style={{ color: '#f59e0b' }}>{s.warm_leads || 0}</div>
            <div className="portal-stat-sub">Comparing / interested</div>
          </div>

          <div className="portal-stat-card" style={{ borderLeft: '4px solid #10b981' }}>
            <div className="portal-stat-label">📅 Appointments</div>
            <div className="portal-stat-value" style={{ color: '#10b981' }}>{s.total_appointments || 0}</div>
            <div className="portal-stat-sub">{s.today_appointments || 0} booked today</div>
          </div>

          <div className="portal-stat-card" style={{ borderLeft: '4px solid #06b6d4' }}>
            <div className="portal-stat-label">⚡ Avg Reply</div>
            <div className="portal-stat-value" style={{ color: '#06b6d4' }}>{s.avg_response_time || '2.4s'}</div>
            <div className="portal-stat-sub">24/7 instant reply</div>
          </div>

          <div className="portal-stat-card" style={{ borderLeft: '4px solid #a855f7' }}>
            <div className="portal-stat-label">⏱️ Hours Saved</div>
            <div className="portal-stat-value" style={{ color: '#a855f7' }}>{s.hours_saved || 0} hrs</div>
            <div className="portal-stat-sub">Staff time automated</div>
          </div>
        </div>

        {/* 2. TAB CONTROLS (Swipeable on mobile) */}
        <div className="portal-tabs-nav">
          {[
            { id: 'leads', label: `👥 Leads (${leads.length})` },
            { id: 'appointments', label: `📅 Appointments (${appointments.length})` },
            { id: 'trends', label: '📊 7-Day Performance' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="portal-tab-btn"
              style={{
                color: activeTab === tab.id ? '#818cf8' : 'var(--text-secondary)',
                background: activeTab === tab.id ? 'rgba(99,102,241,0.12)' : 'transparent',
                borderBottom: activeTab === tab.id ? '2px solid #818cf8' : '2px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ═══════════════════════════════════════════════════════════
            TAB 1: LEADS & CONTACTS EXPLORER
            ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'leads' && (
          <div className="card" style={{ padding: 18 }}>
            {/* Filter and Search Bar */}
            <div className="portal-filter-bar">
              <div className="portal-filter-inputs">
                <input
                  type="text"
                  className="form-input portal-filter-search"
                  placeholder="🔍 Search name or phone..."
                  value={searchLead}
                  onChange={e => setSearchLead(e.target.value)}
                  style={{ fontSize: 13, padding: '8px 12px' }}
                />
                <select
                  className="form-select portal-filter-select"
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                  style={{ fontSize: 13, padding: '8px 12px' }}
                >
                  <option value="all">All Statuses</option>
                  <option value="hot">🔥 Hot Leads</option>
                  <option value="warm">🟡 Warm Leads</option>
                  <option value="cold">❄️ Cold Leads</option>
                  <option value="new">🆕 New Leads</option>
                </select>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Showing <strong>{filteredLeads.length}</strong> inquiries
              </div>
            </div>

            {/* Desktop Leads Table (Only visible on screens >= 768px) */}
            <div className="portal-desktop-table">
              {filteredLeads.length > 0 ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Customer Contact</th>
                      <th>Lead Intent</th>
                      <th>Score</th>
                      <th>Latest Message</th>
                      <th>Captured</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLeads.map(l => (
                      <tr
                        key={l.id}
                        style={{ cursor: 'pointer', transition: 'background 0.15s' }}
                        onClick={() => openLeadChat(l)}
                      >
                        <td>
                          <div style={{ fontWeight: 600, color: '#fff' }}>{l.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{l.phone_number}</div>
                        </td>
                        <td>
                          <span className={`lead-badge ${l.lead_status}`}>
                            <span className="badge-dot"></span>
                            {(l.lead_status || 'new').toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <div className="score-display">
                            <span className="score-number" style={{ color: scoreColor(l.lead_score) }}>
                              {l.lead_score}
                            </span>
                            <div className="score-bar">
                              <div
                                className="score-bar-fill"
                                style={{ width: `${l.lead_score}%`, background: scoreColor(l.lead_score) }}
                              ></div>
                            </div>
                          </div>
                        </td>
                        <td style={{ maxWidth: 320 }}>
                          <div style={{
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {l.last_message || 'Inquiry started'}
                          </div>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                          {timeAgo(l.created_at)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            onClick={e => { e.stopPropagation(); openLeadChat(l); }}
                            className="btn btn-secondary"
                            style={{ fontSize: 11, padding: '4px 10px' }}
                          >
                            💬 View Chat
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty-state" style={{ padding: '40px 0' }}>
                  <div className="empty-icon">📭</div>
                  <p>No customer inquiries matching this filter.</p>
                </div>
              )}
            </div>

            {/* Mobile Leads Card List (Visible on screens <= 768px) */}
            <div className="portal-mobile-leads">
              {filteredLeads.length > 0 ? (
                filteredLeads.map(l => (
                  <div
                    key={l.id}
                    className="portal-lead-card"
                    onClick={() => openLeadChat(l)}
                  >
                    <div className="portal-lead-card-header">
                      <div className="portal-lead-card-name">{l.name}</div>
                      <span className={`lead-badge ${l.lead_status}`} style={{ fontSize: 10, padding: '2px 8px' }}>
                        <span className="badge-dot"></span>
                        {(l.lead_status || 'new').toUpperCase()}
                      </span>
                    </div>

                    <div className="portal-lead-card-meta">
                      <span>📱 {l.phone_number}</span>
                      <span>•</span>
                      <span>⏱️ {timeAgo(l.created_at)}</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Intent Score:</div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor(l.lead_score) }}>
                        {l.lead_score}/100
                      </span>
                      <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${l.lead_score}%`, height: '100%', background: scoreColor(l.lead_score) }} />
                      </div>
                    </div>

                    <div className="portal-lead-card-msg">
                      💬 &ldquo;{l.last_message || 'Inquiry started'}&rdquo;
                    </div>

                    <div className="portal-lead-card-footer">
                      <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>⚡</span> AI Handled
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); openLeadChat(l); }}
                        className="btn btn-secondary"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                      >
                        💬 View Chat →
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state" style={{ padding: '30px 0' }}>
                  <div className="empty-icon">📭</div>
                  <p>No customer inquiries matching this filter.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            TAB 2: BOOKED APPOINTMENTS
            ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'appointments' && (
          <div className="card" style={{ padding: 18 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>📅 Confirmed Customer Appointments</h3>
            {appointments.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                {appointments.map(a => (
                  <div
                    key={a.id}
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 12,
                      padding: 16,
                      borderLeft: '4px solid #10b981',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{a.title || 'Appointment'}</span>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 10,
                        background: 'rgba(16,185,129,0.15)',
                        color: '#10b981',
                        textTransform: 'uppercase',
                      }}>
                        {a.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                      👤 <strong>{a.customer_name}</strong> {a.customer_phone ? `(${a.customer_phone})` : ''}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>🗓️ {a.date}</span>
                      <span>•</span>
                      <span>⏰ {a.start_time} - {a.end_time}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <div className="empty-icon">📅</div>
                <p>No appointments booked yet. They appear when customers schedule via AI chat.</p>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            TAB 3: 7-DAY PERFORMANCE TRENDS
            ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'trends' && (
          <div className="portal-trends-layout" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 18 }}>
            {/* 7-day Bar chart representation */}
            <div className="card" style={{ padding: 18 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>📈 Inquiries & Conversations (Last 7 Days)</h3>
              <div style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                height: 190,
                padding: '20px 6px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.1)',
                gap: 8,
              }}>
                {trends.map((t, idx) => {
                  const maxVal = Math.max(...trends.map(x => Math.max(x.leads, x.messages)), 10);
                  const leadsHeight = Math.max((t.leads / maxVal) * 140, 4);
                  const msgsHeight = Math.max((t.messages / maxVal) * 140, 4);
                  return (
                    <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 140 }}>
                        <div
                          style={{
                            width: 10,
                            height: `${leadsHeight}px`,
                            background: '#6366f1',
                            borderRadius: '3px 3px 0 0',
                            transition: 'height 0.3s',
                          }}
                          title={`${t.leads} leads on ${t.day}`}
                        />
                        <div
                          style={{
                            width: 10,
                            height: `${msgsHeight}px`,
                            background: '#10b981',
                            borderRadius: '3px 3px 0 0',
                            transition: 'height 0.3s',
                          }}
                          title={`${t.messages} messages on ${t.day}`}
                        />
                      </div>
                      <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{t.day}</span>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 14, fontSize: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, background: '#6366f1', borderRadius: 2 }}></span>
                  <span style={{ color: 'var(--text-secondary)' }}>New Leads</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, background: '#10b981', borderRadius: 2 }}></span>
                  <span style={{ color: 'var(--text-secondary)' }}>AI Messages</span>
                </div>
              </div>
            </div>

            {/* Lead Breakdown Card */}
            <div className="card" style={{ padding: 18 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Lead Quality Pipeline</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#ef4444', fontWeight: 600 }}>🔥 Hot Leads</span>
                    <span style={{ fontWeight: 700 }}>{s.hot_leads || 0}</span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${((s.hot_leads || 0) / Math.max(s.total_leads || 1, 1)) * 100}%`, height: '100%', background: '#ef4444' }} />
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#f59e0b', fontWeight: 600 }}>🟡 Warm Leads</span>
                    <span style={{ fontWeight: 700 }}>{s.warm_leads || 0}</span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${((s.warm_leads || 0) / Math.max(s.total_leads || 1, 1)) * 100}%`, height: '100%', background: '#f59e0b' }} />
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#06b6d4', fontWeight: 600 }}>❄️ Cold Leads</span>
                    <span style={{ fontWeight: 700 }}>{s.cold_leads || 0}</span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${((s.cold_leads || 0) / Math.max(s.total_leads || 1, 1)) * 100}%`, height: '100%', background: '#06b6d4' }} />
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 20, padding: 12, background: 'rgba(99,102,241,0.08)', borderRadius: 8, fontSize: 11.5, color: '#818cf8', lineHeight: 1.5 }}>
                💡 <strong>Conversion Tip:</strong> Contact Hot Leads within 15 minutes of inquiry to maximize closing rates.
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── MODAL: READ-ONLY CONVERSATION VIEWER ── */}
      {selectedLead && (
        <div
          className="portal-modal-wrapper"
          onClick={e => e.target === e.currentTarget && setSelectedLead(null)}
        >
          <div className="portal-modal-container">
            {/* Chat Modal Header */}
            <div style={{
              padding: '14px 18px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: '#fff' }}>{selectedLead.name}</span>
                  <span className={`lead-badge ${selectedLead.lead_status}`} style={{ fontSize: 10, padding: '2px 8px' }}>
                    {selectedLead.lead_status.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  📱 {selectedLead.phone_number} • Score: {selectedLead.lead_score}/100
                </div>
              </div>
              <button
                onClick={() => setSelectedLead(null)}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: 'none',
                  color: '#9ca3af',
                  fontSize: 16,
                  cursor: 'pointer',
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
                aria-label="Close Chat"
              >
                ✕
              </button>
            </div>

            {/* Chat Messages Body */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '16px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              background: '#080c16',
              WebkitOverflowScrolling: 'touch',
            }}>
              {loadingChat ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)' }}>
                  <div className="spinner" style={{ margin: '0 auto 12px' }}></div>
                  Loading chat history...
                </div>
              ) : chatMessages.length > 0 ? (
                chatMessages.map(m => {
                  const isCustomer = m.sender_type === 'customer';
                  return (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: isCustomer ? 'flex-start' : 'flex-end',
                        maxWidth: '85%',
                        background: isCustomer ? 'rgba(255,255,255,0.08)' : '#005c4b',
                        color: '#fff',
                        padding: '10px 14px',
                        borderRadius: isCustomer ? '14px 14px 14px 2px' : '14px 14px 2px 14px',
                        fontSize: 13,
                        lineHeight: 1.5,
                        boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                      }}
                    >
                      <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: isCustomer ? '#93c5fd' : '#86efac',
                        marginBottom: 3,
                      }}>
                        {isCustomer ? selectedLead.name : '🤖 AI Assistant'}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {m.text}
                      </div>
                      {m.time && (
                        <div style={{
                          fontSize: 10,
                          color: 'rgba(255,255,255,0.5)',
                          textAlign: 'right',
                          marginTop: 4,
                        }}>
                          {formatWhatsAppTime(m.time)}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)' }}>
                  No messages recorded for this contact yet.
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Read-Only Footer Banner */}
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
              fontSize: 11.5,
              color: 'var(--text-tertiary)',
              textAlign: 'center',
            }}>
              👁️ Monitoring mode • AI is actively handling responses 24/7 on WhatsApp
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

