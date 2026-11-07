'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { API, safeFetch, timeAgo, scoreColor, formatWhatsAppTime } from './lib/utils';
import { useClient } from './lib/ClientContext';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [health, setHealth] = useState({ whatsapp: null, api: null, db: null });
  const [loading, setLoading] = useState(true);
  const { bUrl, selectedClientId } = useClient();

  // Date-wise WhatsApp Analytics State
  const [selectedDate, setSelectedDate] = useState('');
  const [dateStats, setDateStats] = useState(null);
  const [loadingDateStats, setLoadingDateStats] = useState(false);

  // Load Main Stats
  useEffect(() => {
    async function load() {
      try {
        const [d] = await safeFetch(bUrl('/dashboard'));
        const [l] = await safeFetch(bUrl('/leads'));
        const [w] = await safeFetch(`${API}/whatsapp/status`);
        setStats(d);
        setLeads(Array.isArray(l) ? l.slice(0, 5) : []);
        setHealth({
          whatsapp: w?.connected ? 'ok' : 'error',
          api: d ? 'ok' : 'error',
          db: d ? 'ok' : 'error',
        });
      } catch {
        setHealth({ whatsapp: 'error', api: 'error', db: 'error' });
      } finally {
        setLoading(false);
      }
    }
    if (selectedClientId) {
      load();
      const iv = setInterval(load, 20000);
      return () => clearInterval(iv);
    }
  }, [selectedClientId]);

  // Load Date-Specific Stats
  const loadDateStats = async (targetDate = '') => {
    if (!selectedClientId) return;
    setLoadingDateStats(true);
    try {
      const tz = -new Date().getTimezoneOffset(); // in minutes, e.g. 330 for IST
      const query = targetDate ? `&date=${encodeURIComponent(targetDate)}` : '';
      const [data] = await safeFetch(bUrl(`/dashboard/date-stats?tz_offset=${tz}${query}`));
      if (data) {
        setDateStats(data);
        if (data.date) setSelectedDate(data.date);
      }
    } catch (e) {
      console.error('Failed to load date stats', e);
    } finally {
      setLoadingDateStats(false);
    }
  };

  useEffect(() => {
    if (selectedClientId) {
      loadDateStats(selectedDate);
    }
  }, [selectedClientId, selectedDate]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>Loading dashboard...
      </div>
    );
  }

  const d = stats || {};
  const ds = dateStats || {};
  const sum = ds.summary || {};
  const presets = ds.presets || {};
  const contacts = ds.contacts || [];

  // Find peak hour
  const hourly = ds.hourly_distribution || [];
  let peakHour = 'N/A';
  let maxHourlyMsgs = 0;
  for (const h of hourly) {
    if (h.total > maxHourlyMsgs) {
      maxHourlyMsgs = h.total;
      peakHour = h.hour;
    }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Command Center</h2>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Real-time overview of all automation activity</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            borderRadius: 20,
            background: 'rgba(16,185,129,0.1)',
            border: '1px solid rgba(16,185,129,0.25)',
            fontSize: 12,
            color: 'var(--accent)',
            fontWeight: 600
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }}></span>
            Real-time Live Sync
          </span>
        </div>
      </div>

      {/* ── TOP KPI OVERVIEW CARDS ── */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 24 }}>
        <div className="stat-card blue">
          <div className="stat-label">Total Messages Today</div>
          <div className="stat-value">{d.total_messages_today || 0}</div>
          <div className="stat-sub">+{d.total_leads_today || 0} new leads today</div>
        </div>
        <div className="stat-card red">
          <div className="stat-label">Hot Leads</div>
          <div className="stat-value">{d.hot_leads || 0}</div>
          <div className="stat-sub">🔥 Ready to convert</div>
        </div>
        <div className="stat-card orange">
          <div className="stat-label">Warm Leads</div>
          <div className="stat-value">{d.warm_leads || 0}</div>
          <div className="stat-sub">✏ Follow up needed</div>
        </div>
        <div className="stat-card cyan">
          <div className="stat-label">Cold Leads</div>
          <div className="stat-value">{d.cold_leads || 0}</div>
          <div className="stat-sub">❄ Long-term nurture</div>
        </div>
        <div className="stat-card green">
          <div className="stat-label">Appointments Today</div>
          <div className="stat-value">{d.appointments_today || 0}</div>
          <div className="stat-sub">📅 {d.upcoming_appointments || 0} upcoming this week</div>
        </div>
        <div className="stat-card purple">
          <div className="stat-label">Calls Today</div>
          <div className="stat-value">{d.calls_today || 0}</div>
          <div className="stat-sub">🎙️ {d.total_call_minutes || 0} min total</div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          NEW SECTION: 📅 WHATSAPP DAILY MESSAGE & CONTACT INSPECTOR
          ══════════════════════════════════════════════════════════════════ */}
      <div className="card" style={{ marginBottom: 24, padding: '22px 24px', border: '1px solid rgba(99,102,241,0.25)', background: 'linear-gradient(180deg, rgba(19,21,54,0.9), rgba(15,16,41,0.95))' }}>
        {/* Controls Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>📅</span>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                WhatsApp Daily Activity & Message Inspector
              </h3>
              {ds.display_label && (
                <span style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '3px 10px',
                  borderRadius: 12,
                  background: ds.is_today ? 'rgba(16,185,129,0.15)' : ds.is_yesterday ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.08)',
                  color: ds.is_today ? 'var(--accent)' : ds.is_yesterday ? '#60a5fa' : 'var(--text-secondary)',
                  border: `1px solid ${ds.is_today ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.1)'}`
                }}>
                  {ds.display_label}
                </span>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
              Filter by date to view message volume, incoming customer inquiries, AI vs manual replies, and new numbers vs saved contacts.
            </p>
          </div>

          {/* Quick Date Presets & Date Input */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {presets.today_date && (
              <button
                onClick={() => setSelectedDate(presets.today_date)}
                className={`btn btn-sm ${selectedDate === presets.today_date ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: 11.5, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span>Today</span>
                <span style={{
                  background: selectedDate === presets.today_date ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)',
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: 10,
                  fontWeight: 700
                }}>
                  {presets.today_messages || 0}
                </span>
              </button>
            )}

            {presets.yesterday_date && (
              <button
                onClick={() => setSelectedDate(presets.yesterday_date)}
                className={`btn btn-sm ${selectedDate === presets.yesterday_date ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: 11.5, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span>Yesterday</span>
                <span style={{
                  background: selectedDate === presets.yesterday_date ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)',
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: 10,
                  fontWeight: 700
                }}>
                  {presets.yesterday_messages || 0}
                </span>
              </button>
            )}

            {/* Custom Date Picker */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type="date"
                className="form-input"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  background: 'var(--bg-primary)',
                  borderColor: 'rgba(99,102,241,0.3)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer'
                }}
              />
            </div>

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

        {/* 6 High-Impact Metric Cards for Selected Date */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
          marginBottom: 20
        }}>
          {/* Card 1: Total Messages */}
          <div style={{ padding: '14px 16px', background: 'rgba(99,102,241,0.08)', borderRadius: 10, border: '1px solid rgba(99,102,241,0.2)' }}>
            <div style={{ fontSize: 11, color: '#a5b4fc', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Total Messages
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', marginTop: 4 }}>
              {sum.total_messages || 0}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {sum.active_conversations || 0} active conversations
            </div>
          </div>

          {/* Card 2: Inbound Customer Inquiries */}
          <div style={{ padding: '14px 16px', background: 'rgba(16,185,129,0.08)', borderRadius: 10, border: '1px solid rgba(16,185,129,0.2)' }}>
            <div style={{ fontSize: 11, color: '#6ee7b7', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              📥 Inbound Inquiries
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#10b981', marginTop: 4 }}>
              {sum.incoming_messages || 0}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              Messages from customers
            </div>
          </div>

          {/* Card 3: AI Auto-Replies */}
          <div style={{ padding: '14px 16px', background: 'rgba(59,130,246,0.08)', borderRadius: 10, border: '1px solid rgba(59,130,246,0.2)' }}>
            <div style={{ fontSize: 11, color: '#93c5fd', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              🤖 AI Automated
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#3b82f6', marginTop: 4 }}>
              {sum.ai_replies || 0}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              Instant 24/7 replies
            </div>
          </div>

          {/* Card 4: Owner Manual Replies */}
          <div style={{ padding: '14px 16px', background: 'rgba(245,158,11,0.08)', borderRadius: 10, border: '1px solid rgba(245,158,11,0.2)' }}>
            <div style={{ fontSize: 11, color: '#fcd34d', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              👤 Manual Replies
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#f59e0b', marginTop: 4 }}>
              {sum.human_replies || 0}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              Sent from phone / web
            </div>
          </div>

          {/* Card 5: New Numbers */}
          <div style={{ padding: '14px 16px', background: 'rgba(236,72,153,0.08)', borderRadius: 10, border: '1px solid rgba(236,72,153,0.2)' }}>
            <div style={{ fontSize: 11, color: '#f472b6', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              🆕 New Numbers
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#ec4899', marginTop: 4 }}>
              {sum.new_numbers || 0}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              First contact on this date
            </div>
          </div>

          {/* Card 6: Saved Contacts */}
          <div style={{ padding: '14px 16px', background: 'rgba(168,85,247,0.08)', borderRadius: 10, border: '1px solid rgba(168,85,247,0.2)' }}>
            <div style={{ fontSize: 11, color: '#c084fc', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              📇 Saved Contacts
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#a855f7', marginTop: 4 }}>
              {sum.saved_contacts || 0}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              Contacts with saved names
            </div>
          </div>
        </div>

        {/* Detail Breakdown: Active Contacts on this Date & Date Insights */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16 }}>
          {/* Active Contacts Table */}
          <div style={{
            background: 'var(--bg-primary)',
            borderRadius: 10,
            border: '1px solid var(--border-color)',
            overflow: 'hidden'
          }}>
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                👥 Active Contacts on {ds.display_label || 'this Date'} ({contacts.length})
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                Sorted by message volume
              </span>
            </div>

            {loadingDateStats ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>
                <div className="spinner" style={{ margin: '0 auto 10px' }}></div>
                Loading activity for {ds.display_label}...
              </div>
            ) : contacts.length > 0 ? (
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="data-table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Contact</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Messages</th>
                      <th>Last Message</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map(c => (
                      <tr key={c.lead_id}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.phone_number}</div>
                        </td>
                        <td>
                          {c.is_new ? (
                            <span style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 7px',
                              borderRadius: 10,
                              background: 'rgba(236,72,153,0.15)',
                              color: '#f472b6',
                              border: '1px solid rgba(236,72,153,0.3)'
                            }}>
                              🆕 New Number
                            </span>
                          ) : c.is_saved_name ? (
                            <span style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 7px',
                              borderRadius: 10,
                              background: 'rgba(168,85,247,0.15)',
                              color: '#c084fc',
                              border: '1px solid rgba(168,85,247,0.3)'
                            }}>
                              📇 Saved Contact
                            </span>
                          ) : (
                            <span style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: '2px 7px',
                              borderRadius: 10,
                              background: 'rgba(255,255,255,0.06)',
                              color: 'var(--text-secondary)'
                            }}>
                              Returning
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`lead-badge ${c.lead_status || 'new'}`} style={{ fontSize: 10, padding: '2px 7px' }}>
                            <span className="badge-dot" style={{ width: 4, height: 4 }}></span>
                            {(c.lead_status || 'new').toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                            {c.messages_count}
                          </span>
                        </td>
                        <td style={{ maxWidth: 220 }}>
                          <div style={{
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}>
                            {c.last_message || '—'}
                          </div>
                          {c.last_time && (
                            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
                              {c.last_time}
                            </div>
                          )}
                        </td>
                        <td>
                          <Link
                            href="/conversations"
                            className="btn btn-secondary btn-sm"
                            style={{ fontSize: 11, padding: '4px 10px' }}
                          >
                            💬 Open Chat
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '36px 20px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  No messages recorded on {ds.display_label || 'this date'}
                </div>
                <p style={{ fontSize: 12, maxWidth: 360, margin: '0 auto 12px' }}>
                  Try clicking <strong>Today</strong> or <strong>Yesterday</strong> above, or choose a different date from the calendar.
                </p>
                {presets.today_date && selectedDate !== presets.today_date && (
                  <button
                    onClick={() => setSelectedDate(presets.today_date)}
                    className="btn btn-primary btn-sm"
                    style={{ fontSize: 11 }}
                  >
                    View Today's Messages
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Date Summary Insights Box */}
          <div style={{
            background: 'var(--bg-primary)',
            borderRadius: 10,
            border: '1px solid var(--border-color)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 12
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>
                🎯 Key Outcomes on {ds.display_label}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>📅 Appointments Scheduled</span>
                  <span style={{ fontWeight: 700, color: 'var(--success)' }}>{sum.appointments_count || 0}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>⚡ AI Automation Ratio</span>
                  <span style={{ fontWeight: 700, color: 'var(--accent)' }}>
                    {sum.incoming_messages > 0 ? Math.round((sum.ai_replies / sum.incoming_messages) * 100) : 100}%
                  </span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>🕒 Peak Activity Hour</span>
                  <span style={{ fontWeight: 700, color: '#fff' }}>{peakHour !== 'N/A' ? `${peakHour}` : 'None'}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>👥 Returning Contacts</span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{sum.returning_contacts || 0}</span>
                </div>
              </div>
            </div>

            <div style={{
              padding: 12,
              background: 'rgba(99,102,241,0.06)',
              borderRadius: 8,
              border: '1px solid rgba(99,102,241,0.15)',
              fontSize: 11.5,
              color: 'var(--text-secondary)',
              lineHeight: 1.5
            }}>
              💡 <strong>Pro Tip:</strong> New Numbers are prospects contacting you for the first time. Follow up immediately to convert them into confirmed bookings!
            </div>
          </div>
        </div>
      </div>

      {/* ── RECENT ACTIVITY & SIDEBAR ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20 }}>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span className="card-header" style={{ marginBottom: 0 }}>Recent Activity</span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>All Captured Leads</span>
          </div>
          {leads.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Score</th>
                  <th>Label</th>
                  <th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {leads.map(l => (
                  <tr key={l.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{l.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{l.phone_number}</div>
                    </td>
                    <td>
                      <div className="score-display">
                        <span className="score-number" style={{ color: scoreColor(l.lead_score) }}>{l.lead_score}</span>
                        <div className="score-bar">
                          <div className="score-bar-fill" style={{ width: `${l.lead_score}%`, background: scoreColor(l.lead_score) }}></div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`lead-badge ${l.lead_status}`}>
                        <span className="badge-dot"></span>
                        {(l.lead_status || 'new').toUpperCase()}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{timeAgo(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <p>No leads yet. They appear when customers message your WhatsApp.</p>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Lead Distribution */}
          <div className="card">
            <div className="card-header">Lead Distribution</div>
            <div style={{ display: 'flex', gap: 24, marginTop: 12, marginBottom: 12 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--hot)' }}>{d.hot_leads || 0}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Hot</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--warm)' }}>{d.warm_leads || 0}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Warm</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--cold)' }}>{d.cold_leads || 0}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Cold</div>
              </div>
            </div>
            <div style={{ display: 'flex', height: 6, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.04)' }}>
              {(d.hot_leads > 0 || d.warm_leads > 0 || d.cold_leads > 0) ? (
                <>
                  <div style={{ width: `${((d.hot_leads || 0) / Math.max((d.hot_leads || 0) + (d.warm_leads || 0) + (d.cold_leads || 0), 1)) * 100}%`, background: 'var(--hot)' }}></div>
                  <div style={{ width: `${((d.warm_leads || 0) / Math.max((d.hot_leads || 0) + (d.warm_leads || 0) + (d.cold_leads || 0), 1)) * 100}%`, background: 'var(--warm)' }}></div>
                  <div style={{ width: `${((d.cold_leads || 0) / Math.max((d.hot_leads || 0) + (d.warm_leads || 0) + (d.cold_leads || 0), 1)) * 100}%`, background: 'var(--cold)' }}></div>
                </>
              ) : (
                <div style={{ width: '100%' }}></div>
              )}
            </div>
          </div>

          {/* Platform Overview */}
          <div className="card">
            <div className="card-header">Platform Overview</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Total Leads</span>
                <span style={{ fontWeight: 700 }}>{d.total_leads || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Total Conversations</span>
                <span style={{ fontWeight: 700 }}>{d.total_conversations || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Active Today</span>
                <span style={{ fontWeight: 700, color: 'var(--accent)' }}>{d.active_conversations || 0}</span>
              </div>
            </div>
          </div>

          {/* System Health */}
          <div className="card">
            <div className="card-header">System Health</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
              {[
                ['WhatsApp API', health.whatsapp],
                ['AI Agent API', health.api],
                ['Database', health.db],
              ].map(([n, s]) => (
                <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{n}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className={`health-dot ${s}`}></span>
                    {s === 'ok' ? 'OK' : 'Offline'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
