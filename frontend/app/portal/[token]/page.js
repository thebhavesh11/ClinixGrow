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
  const [activeTab, setActiveTab] = useState('leads'); // 'leads' | 'messages' | 'appointments' | 'trends'
  const [overview, setOverview] = useState(null);
  const [leads, setLeads] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [searchLead, setSearchLead] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  // Date-wise Message Analytics states
  const [selectedDate, setSelectedDate] = useState('');
  const [dateStats, setDateStats] = useState(null);
  const [loadingDateStats, setLoadingDateStats] = useState(false);

  // Google Sheets Export states
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportStatus, setExportStatus] = useState('all');
  const [exportDatePreset, setExportDatePreset] = useState('all');
  const [exportStartDate, setExportStartDate] = useState('');
  const [exportEndDate, setExportEndDate] = useState('');
  const [copiedFormula, setCopiedFormula] = useState(false);

  // Add Lead Modal states
  const [showAddLeadModal, setShowAddLeadModal] = useState(false);
  const [newLeadForm, setNewLeadForm] = useState({ name: '', phone_number: '', lead_status: 'hot', summary: '', suggested_action: '' });
  const [savingLead, setSavingLead] = useState(false);

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

    loadDateStats(selectedDate, currentPin);
  }

  async function loadDateStats(targetDate = '', currentPin = pin) {
    if (!token) return;
    setLoadingDateStats(true);
    const headers = {};
    if (currentPin) headers['X-Portal-PIN'] = currentPin;
    const tz = -new Date().getTimezoneOffset();
    const query = targetDate ? `&date=${encodeURIComponent(targetDate)}` : '';
    const [data] = await safeFetch(`${API}/portal/${token}/date-stats?tz_offset=${tz}${query}`, { headers });
    setLoadingDateStats(false);
    if (data) {
      setDateStats(data);
      if (data.date && !targetDate) setSelectedDate(data.date);
    }
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

  // Trigger custom CSV export (opens in Google Sheets & Excel)
  function triggerLeadsExport() {
    const tz = -new Date().getTimezoneOffset();
    let url = `${API}/portal/${token}/export-leads?tz_offset=${tz}`;
    if (exportStatus && exportStatus !== 'all') url += `&status=${encodeURIComponent(exportStatus)}`;
    if (exportDatePreset && exportDatePreset !== 'all') url += `&date_preset=${encodeURIComponent(exportDatePreset)}`;
    if (exportDatePreset === 'custom') {
      if (exportStartDate) url += `&start_date=${encodeURIComponent(exportStartDate)}`;
      if (exportEndDate) url += `&end_date=${encodeURIComponent(exportEndDate)}`;
    }
    window.open(url, '_blank');
    showToast('Downloading Google Sheets / Excel CSV...', 'success');
    setShowExportModal(false);
  }

  // Google Sheets Live Sync Formula
  function getGoogleSheetsFormula() {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://smartflow55.xyz';
    let url = `${origin}/api/portal/${token}/export-leads?tz_offset=330`;
    if (exportStatus && exportStatus !== 'all') url += `&status=${encodeURIComponent(exportStatus)}`;
    if (exportDatePreset && exportDatePreset !== 'all') url += `&date_preset=${encodeURIComponent(exportDatePreset)}`;
    return `=IMPORTDATA("${url}")`;
  }

  // Save new lead manually
  async function handleSaveNewLead(e) {
    if (e) e.preventDefault();
    if (!newLeadForm.phone_number.trim()) {
      showToast('Please enter a phone number', 'error');
      return;
    }
    setSavingLead(true);
    const headers = getHeaders();
    const [res, err] = await safeFetch(`${API}/portal/${token}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(newLeadForm),
    });
    setSavingLead(false);
    if (res?.success) {
      showToast(res.action === 'created' ? 'Lead saved successfully!' : 'Lead updated successfully!', 'success');
      setShowAddLeadModal(false);
      setNewLeadForm({ name: '', phone_number: '', lead_status: 'hot', summary: '', suggested_action: '' });
      loadPortalData();
    } else {
      showToast(err || 'Failed to save lead', 'error');
    }
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
              onClick={() => setShowAddLeadModal(true)}
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
              title="Manually save a new lead"
            >
              <span>➕ Add Lead</span>
            </button>

            <button
              onClick={() => setShowExportModal(true)}
              className="btn btn-primary"
              style={{ fontSize: 12, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
              title="Download or sync leads with Google Sheets / Excel"
            >
              <span>📊 Export Google Sheet</span>
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
            { id: 'messages', label: `📅 Daily Messages & Activity` },
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

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  Showing <strong>{filteredLeads.length}</strong> inquiries
                </span>
                <button
                  onClick={() => setShowAddLeadModal(true)}
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: 11.5, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 5 }}
                >
                  ➕ Add Lead
                </button>
                <button
                  onClick={() => setShowExportModal(true)}
                  className="btn btn-primary btn-sm"
                  style={{ fontSize: 11.5, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 5 }}
                >
                  📊 Export Sheet
                </button>
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

                    {l.summary && (
                      <div style={{ fontSize: 11.5, color: '#93c5fd', marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.4 }}>
                        <span style={{ flexShrink: 0 }}>📝</span>
                        <span><strong>Need:</strong> {l.summary}</span>
                      </div>
                    )}
                    {l.suggested_action && (
                      <div style={{ fontSize: 11, color: '#fcd34d', marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.4 }}>
                        <span style={{ flexShrink: 0 }}>🎯</span>
                        <span><strong>Next Step:</strong> {l.suggested_action}</span>
                      </div>
                    )}

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
            TAB 2: DAILY MESSAGES & ACTIVITY INSPECTOR
            ═══════════════════════════════════════════════════════════ */}
        {activeTab === 'messages' && (
          <div className="card" style={{ padding: 20 }}>
            {/* Header & Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginBottom: 20 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20 }}>📅</span>
                  <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#fff' }}>
                    WhatsApp Daily Activity & Message Inspector
                  </h3>
                  {dateStats?.display_label && (
                    <span style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '3px 10px',
                      borderRadius: 12,
                      background: dateStats.is_today ? 'rgba(16,185,129,0.15)' : dateStats.is_yesterday ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.08)',
                      color: dateStats.is_today ? 'var(--accent)' : dateStats.is_yesterday ? '#60a5fa' : 'var(--text-secondary)',
                      border: `1px solid ${dateStats.is_today ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)'}`
                    }}>
                      {dateStats.display_label}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Select any date to see incoming customer inquiries, AI vs manual replies, and new numbers vs saved contacts.
                </p>
              </div>

              {/* Quick Presets & Calendar Date Input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {dateStats?.presets?.today_date && (
                  <button
                    onClick={() => {
                      setSelectedDate(dateStats.presets.today_date);
                      loadDateStats(dateStats.presets.today_date);
                    }}
                    className={`btn btn-sm ${selectedDate === dateStats.presets.today_date ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: 11.5, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span>Today</span>
                    <span style={{
                      background: selectedDate === dateStats.presets.today_date ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)',
                      padding: '1px 6px',
                      borderRadius: 10,
                      fontSize: 10,
                      fontWeight: 700
                    }}>
                      {dateStats.presets.today_messages || 0}
                    </span>
                  </button>
                )}

                {dateStats?.presets?.yesterday_date && (
                  <button
                    onClick={() => {
                      setSelectedDate(dateStats.presets.yesterday_date);
                      loadDateStats(dateStats.presets.yesterday_date);
                    }}
                    className={`btn btn-sm ${selectedDate === dateStats.presets.yesterday_date ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: 11.5, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span>Yesterday</span>
                    <span style={{
                      background: selectedDate === dateStats.presets.yesterday_date ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)',
                      padding: '1px 6px',
                      borderRadius: 10,
                      fontSize: 10,
                      fontWeight: 700
                    }}>
                      {dateStats.presets.yesterday_messages || 0}
                    </span>
                  </button>
                )}

                <input
                  type="date"
                  className="form-input"
                  value={selectedDate}
                  onChange={e => {
                    setSelectedDate(e.target.value);
                    loadDateStats(e.target.value);
                  }}
                  style={{
                    fontSize: 12,
                    padding: '6px 12px',
                    background: 'var(--bg-primary)',
                    borderColor: 'rgba(99,102,241,0.3)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer'
                  }}
                />

                <button
                  onClick={() => loadDateStats(selectedDate)}
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: 13, padding: '6px 10px' }}
                  title="Refresh date analytics"
                >
                  {loadingDateStats ? '⏳' : '↻'}
                </button>
              </div>
            </div>

            {/* 6 Metric Cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
              marginBottom: 20
            }}>
              <div style={{ padding: '14px 16px', background: 'rgba(99,102,241,0.08)', borderRadius: 10, border: '1px solid rgba(99,102,241,0.2)' }}>
                <div style={{ fontSize: 11, color: '#a5b4fc', fontWeight: 600, textTransform: 'uppercase' }}>Total Messages</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', marginTop: 4 }}>
                  {dateStats?.summary?.total_messages || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {dateStats?.summary?.active_conversations || 0} active chats
                </div>
              </div>

              <div style={{ padding: '14px 16px', background: 'rgba(16,185,129,0.08)', borderRadius: 10, border: '1px solid rgba(16,185,129,0.2)' }}>
                <div style={{ fontSize: 11, color: '#6ee7b7', fontWeight: 600, textTransform: 'uppercase' }}>📥 Inbound Inquiries</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#10b981', marginTop: 4 }}>
                  {dateStats?.summary?.incoming_messages || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>From customers</div>
              </div>

              <div style={{ padding: '14px 16px', background: 'rgba(59,130,246,0.08)', borderRadius: 10, border: '1px solid rgba(59,130,246,0.2)' }}>
                <div style={{ fontSize: 11, color: '#93c5fd', fontWeight: 600, textTransform: 'uppercase' }}>🤖 AI Automated</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#3b82f6', marginTop: 4 }}>
                  {dateStats?.summary?.ai_replies || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>24/7 instant replies</div>
              </div>

              <div style={{ padding: '14px 16px', background: 'rgba(245,158,11,0.08)', borderRadius: 10, border: '1px solid rgba(245,158,11,0.2)' }}>
                <div style={{ fontSize: 11, color: '#fcd34d', fontWeight: 600, textTransform: 'uppercase' }}>👤 Manual Replies</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#f59e0b', marginTop: 4 }}>
                  {dateStats?.summary?.human_replies || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>Sent by staff</div>
              </div>

              <div style={{ padding: '14px 16px', background: 'rgba(236,72,153,0.08)', borderRadius: 10, border: '1px solid rgba(236,72,153,0.2)' }}>
                <div style={{ fontSize: 11, color: '#f472b6', fontWeight: 600, textTransform: 'uppercase' }}>🆕 New Numbers</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#ec4899', marginTop: 4 }}>
                  {dateStats?.summary?.new_numbers || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>New customer leads</div>
              </div>

              <div style={{ padding: '14px 16px', background: 'rgba(168,85,247,0.08)', borderRadius: 10, border: '1px solid rgba(168,85,247,0.2)' }}>
                <div style={{ fontSize: 11, color: '#c084fc', fontWeight: 600, textTransform: 'uppercase' }}>📇 Saved Contacts</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#a855f7', marginTop: 4 }}>
                  {dateStats?.summary?.saved_contacts || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>In address book</div>
              </div>
            </div>

            {/* Split: Contact List & Daily Insights */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 16 }}>
              {/* Active Contacts */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.08)',
                overflow: 'hidden'
              }}>
                <div style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
                    Active Contacts ({dateStats?.contacts?.length || 0})
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    Ranked by chat activity
                  </span>
                </div>

                {loadingDateStats ? (
                  <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>
                    <div className="spinner" style={{ margin: '0 auto 10px' }}></div>
                    Loading messages...
                  </div>
                ) : (dateStats?.contacts?.length || 0) > 0 ? (
                  <div style={{ maxHeight: 350, overflowY: 'auto' }}>
                    {dateStats.contacts.map(c => (
                      <div
                        key={c.lead_id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '12px 16px',
                          borderBottom: '1px solid rgba(255,255,255,0.05)',
                          gap: 12
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                            <span style={{ fontWeight: 600, fontSize: 13.5, color: '#fff' }}>{c.name}</span>
                            {c.is_new ? (
                              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: 'rgba(236,72,153,0.15)', color: '#f472b6', fontWeight: 700 }}>
                                🆕 NEW
                              </span>
                            ) : c.is_saved_name ? (
                              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: 'rgba(168,85,247,0.15)', color: '#c084fc', fontWeight: 700 }}>
                                📇 SAVED
                              </span>
                            ) : null}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                            📱 {c.phone_number} • {c.messages_count} messages
                          </div>
                          {c.summary ? (
                            <div style={{ fontSize: 11.5, color: '#93c5fd', marginTop: 3 }}>
                              📝 {c.summary}
                            </div>
                          ) : c.last_message ? (
                            <div style={{
                              fontSize: 11.5,
                              color: 'var(--text-secondary)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              marginTop: 2
                            }}>
                              💬 {c.last_message}
                            </div>
                          ) : null}

                          {c.suggested_action && (
                            <div style={{ fontSize: 10.5, color: '#fcd34d', marginTop: 2 }}>
                              🎯 {c.suggested_action}
                            </div>
                          )}
                        </div>

                        <button
                          onClick={() => openLeadChat({ id: c.lead_id, name: c.name, phone_number: c.phone_number, lead_status: c.lead_status, lead_score: c.lead_score })}
                          className="btn btn-secondary btn-sm"
                          style={{ fontSize: 11, padding: '5px 12px', flexShrink: 0 }}
                        >
                          👁️ View Chat
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: '36px 20px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                    <div style={{ fontSize: 30, marginBottom: 8 }}>📭</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                      No messages recorded on {dateStats?.display_label || 'this date'}
                    </div>
                  </div>
                )}
              </div>

              {/* Insights Box */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.08)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 12
              }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 12 }}>
                    🎯 Outcomes on this Date
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Appointments Booked</span>
                      <span style={{ fontWeight: 700, color: '#10b981' }}>{dateStats?.summary?.appointments_count || 0}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>AI Automation Ratio</span>
                      <span style={{ fontWeight: 700, color: '#3b82f6' }}>
                        {dateStats?.summary?.incoming_messages > 0 ? Math.round((dateStats.summary.ai_replies / dateStats.summary.incoming_messages) * 100) : 100}%
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Returning Customers</span>
                      <span style={{ fontWeight: 700, color: '#fff' }}>{dateStats?.summary?.returning_contacts || 0}</span>
                    </div>
                  </div>
                </div>

                <div style={{
                  padding: 12,
                  background: 'rgba(99,102,241,0.08)',
                  borderRadius: 8,
                  fontSize: 11,
                  color: '#818cf8',
                  lineHeight: 1.5
                }}>
                  ✨ <strong>Automation Active:</strong> Every customer message is handled instantly with zero delay, booking appointments directly into your calendar.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            TAB 3: BOOKED APPOINTMENTS
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

      {/* ── MODAL: GOOGLE SHEETS & EXCEL EXPORT ── */}
      {showExportModal && (
        <div
          className="portal-modal-wrapper"
          onClick={e => e.target === e.currentTarget && setShowExportModal(false)}
        >
          <div className="portal-modal-container" style={{ maxWidth: 520 }}>
            {/* Header */}
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>📊</span> Export Leads to Google Sheets / Excel
                </h3>
                <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '2px 0 0' }}>
                  Filter and download customer inquiries customized to your preferences
                </p>
              </div>
              <button
                onClick={() => setShowExportModal(false)}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: 'none',
                  color: '#9ca3af',
                  fontSize: 16,
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Status Filter */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                  1. Filter by Lead Status:
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 8 }}>
                  {[
                    { id: 'all', label: 'All Leads' },
                    { id: 'hot', label: '🔥 Hot' },
                    { id: 'warm', label: '🟡 Warm' },
                    { id: 'cold', label: '❄️ Cold' },
                    { id: 'new', label: '🆕 New' },
                  ].map(st => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setExportStatus(st.id)}
                      style={{
                        padding: '8px 10px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: exportStatus === st.id ? '2px solid #818cf8' : '1px solid rgba(255,255,255,0.1)',
                        background: exportStatus === st.id ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
                        color: exportStatus === st.id ? '#fff' : 'var(--text-secondary)',
                        cursor: 'pointer',
                        transition: 'all 0.15s'
                      }}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date Filter */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                  2. Filter by Date Range:
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
                  {[
                    { id: 'all', label: 'All Time' },
                    { id: 'today', label: 'Today' },
                    { id: 'yesterday', label: 'Yesterday' },
                    { id: 'week', label: 'Last 7 Days' },
                    { id: 'month', label: 'This Month' },
                    { id: 'custom', label: '📅 Custom' },
                  ].map(dp => (
                    <button
                      key={dp.id}
                      type="button"
                      onClick={() => setExportDatePreset(dp.id)}
                      style={{
                        padding: '7px 10px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: exportDatePreset === dp.id ? '2px solid #10b981' : '1px solid rgba(255,255,255,0.1)',
                        background: exportDatePreset === dp.id ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.04)',
                        color: exportDatePreset === dp.id ? '#fff' : 'var(--text-secondary)',
                        cursor: 'pointer'
                      }}
                    >
                      {dp.label}
                    </button>
                  ))}
                </div>

                {exportDatePreset === 'custom' && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-tertiary)', display: 'block', marginBottom: 3 }}>From Date</span>
                      <input
                        type="date"
                        className="form-input"
                        value={exportStartDate}
                        onChange={e => setExportStartDate(e.target.value)}
                        style={{ fontSize: 12, padding: '6px 10px' }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-tertiary)', display: 'block', marginBottom: 3 }}>To Date</span>
                      <input
                        type="date"
                        className="form-input"
                        value={exportEndDate}
                        onChange={e => setExportEndDate(e.target.value)}
                        style={{ fontSize: 12, padding: '6px 10px' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Action 1: Direct Download */}
              <div style={{
                background: 'rgba(255,255,255,0.03)',
                padding: '14px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.08)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>Option A: Direct Download</span>
                  <span style={{ fontSize: 10, background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '2px 8px', borderRadius: 10, fontWeight: 700 }}>
                    Google Sheets / Excel CSV
                  </span>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 12, lineHeight: 1.4 }}>
                  Includes Name, Phone, Status, Score, Customer Need Summary, Next Best Action, and Message History.
                </p>
                <button
                  type="button"
                  onClick={triggerLeadsExport}
                  className="btn btn-primary"
                  style={{ width: '100%', padding: '10px 14px', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                >
                  <span>📥 Download CSV File</span>
                </button>
              </div>

              {/* Action 2: Live Google Sheets Sync Formula */}
              <div style={{
                background: 'rgba(99,102,241,0.06)',
                padding: '14px',
                borderRadius: 10,
                border: '1px solid rgba(99,102,241,0.2)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#818cf8' }}>Option B: Live Google Sheets Formula</span>
                  <span style={{ fontSize: 10, background: 'rgba(99,102,241,0.2)', color: '#818cf8', padding: '2px 8px', borderRadius: 10, fontWeight: 700 }}>
                    Auto-Updating
                  </span>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 10, lineHeight: 1.4 }}>
                  Paste this formula in cell <strong>A1</strong> of a Google Sheet. It will automatically keep all your leads synced in real time!
                </p>

                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'rgba(0,0,0,0.3)',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.08)'
                }}>
                  <input
                    type="text"
                    readOnly
                    value={getGoogleSheetsFormula()}
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      color: '#6ee7b7',
                      fontSize: 11,
                      fontFamily: 'monospace',
                      outline: 'none',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(getGoogleSheetsFormula());
                      setCopiedFormula(true);
                      setTimeout(() => setCopiedFormula(false), 2500);
                      showToast('Google Sheets formula copied!', 'success');
                    }}
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }}
                  >
                    {copiedFormula ? '✓ Copied' : '📋 Copy'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: ADD NEW LEAD MANUALLY ── */}
      {showAddLeadModal && (
        <div
          className="portal-modal-wrapper"
          onClick={e => e.target === e.currentTarget && setShowAddLeadModal(false)}
        >
          <div className="portal-modal-container" style={{ maxWidth: 460 }}>
            {/* Header */}
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>➕</span> Add Customer Lead
                </h3>
                <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '2px 0 0' }}>
                  Save a walk-in, phone call, or referral contact to your portal
                </p>
              </div>
              <button
                onClick={() => setShowAddLeadModal(false)}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: 'none',
                  color: '#9ca3af',
                  fontSize: 16,
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ✕
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSaveNewLead} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
                  Customer Phone Number *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. +91 98765 43210"
                  className="form-input"
                  value={newLeadForm.phone_number}
                  onChange={e => setNewLeadForm({ ...newLeadForm, phone_number: e.target.value })}
                  style={{ fontSize: 13 }}
                  autoFocus
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
                  Customer Full Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Rahul Sharma"
                  className="form-input"
                  value={newLeadForm.name}
                  onChange={e => setNewLeadForm({ ...newLeadForm, name: e.target.value })}
                  style={{ fontSize: 13 }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
                  Lead Intent Status
                </label>
                <select
                  className="form-select"
                  value={newLeadForm.lead_status}
                  onChange={e => setNewLeadForm({ ...newLeadForm, lead_status: e.target.value })}
                  style={{ fontSize: 13 }}
                >
                  <option value="hot">🔥 Hot Lead (Ready to buy/visit)</option>
                  <option value="warm">🟡 Warm Lead (Interested/Comparing)</option>
                  <option value="cold">❄️ Cold Lead (Just browsing)</option>
                  <option value="new">🆕 New Lead</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
                  Customer Need / Requirement Note
                </label>
                <textarea
                  placeholder="What does the customer need? e.g. Wants consultation for dental implant"
                  className="form-textarea"
                  rows={2}
                  value={newLeadForm.summary}
                  onChange={e => setNewLeadForm({ ...newLeadForm, summary: e.target.value })}
                  style={{ fontSize: 12.5 }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 5 }}>
                  Next Best Action for Staff
                </label>
                <input
                  type="text"
                  placeholder="e.g. Call back on Friday at 4 PM"
                  className="form-input"
                  value={newLeadForm.suggested_action}
                  onChange={e => setNewLeadForm({ ...newLeadForm, suggested_action: e.target.value })}
                  style={{ fontSize: 12.5 }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => setShowAddLeadModal(false)}
                  className="btn btn-secondary"
                  style={{ flex: 1, padding: '10px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLead}
                  className="btn btn-primary"
                  style={{ flex: 2, padding: '10px' }}
                >
                  {savingLead ? 'Saving...' : '💾 Save Customer Lead'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

