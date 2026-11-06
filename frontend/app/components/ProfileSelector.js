'use client';
import { useState } from 'react';
import { API, safeFetch } from '../lib/utils';
import { useClient } from '../lib/ClientContext';

// Color palette for profile avatars (Netflix-inspired)
const AVATAR_COLORS = [
  { bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', icon: '🏢' },
  { bg: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', icon: '💼' },
  { bg: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', icon: '🏪' },
  { bg: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)', icon: '🏥' },
  { bg: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)', icon: '🎯' },
  { bg: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)', icon: '⚡' },
  { bg: 'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)', icon: '🔥' },
  { bg: 'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)', icon: '🌟' },
];

function getAvatarStyle(index) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function getInitials(name) {
  if (!name) return '?';
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function ProfileSelector() {
  const { clients, enterClient, loadClients, loading } = useClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', industry: '', services: '', location: '' });
  const [creating, setCreating] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const [manageMode, setManageMode] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [toast, setToast] = useState(null);

  async function deleteClient(id, name, e) {
    if (e) e.stopPropagation();
    if (!confirm(`Are you sure you want to delete "${name}"?\n\nThis will permanently delete ALL data for this client:\n- Leads & Contacts\n- Conversations & Messages\n- Appointments\n- AI System Prompts & Settings\n- WhatsApp Session & Chats\n\nThis cannot be undone!`)) return;

    setDeletingId(id);
    const [, err] = await safeFetch(`${API}/clients/${id}`, { method: 'DELETE' });
    setDeletingId(null);
    if (err) {
      setToast({ msg: err, type: 'error' });
      setTimeout(() => setToast(null), 3000);
      return;
    }
    setToast({ msg: `Client "${name}" deleted successfully!`, type: 'success' });
    setTimeout(() => setToast(null), 3000);
    await loadClients();
  }

  async function createClient() {
    if (!form.name.trim()) { setToast({ msg: 'Client name is required', type: 'error' }); setTimeout(() => setToast(null), 3000); return; }
    setCreating(true);
    const [data, err] = await safeFetch(`${API}/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    setCreating(false);
    if (err) { setToast({ msg: err, type: 'error' }); setTimeout(() => setToast(null), 3000); return; }
    setForm({ name: '', industry: '', services: '', location: '' });
    setShowCreate(false);
    await loadClients();
    // Auto-enter the newly created client
    if (data?.id) {
      setTimeout(() => enterClient(data.id), 300);
    }
  }

  if (loading) {
    return (
      <div className="profile-selector-bg">
        <div className="profile-loading">
          <div className="profile-logo">
            <span className="profile-logo-icon">⚡</span>
            <span className="profile-logo-text">FlowBot AI</span>
          </div>
          <div className="spinner" style={{ marginTop: 32 }}></div>
        </div>
      </div>
    );
  }

  return (
    <div className="profile-selector-bg">
      {/* Animated background particles */}
      <div className="profile-bg-particles">
        {[...Array(20)].map((_, i) => (
          <div key={i} className="profile-particle" style={{
            left: `${Math.random() * 100}%`,
            top: `${Math.random() * 100}%`,
            animationDelay: `${Math.random() * 5}s`,
            animationDuration: `${3 + Math.random() * 4}s`,
          }} />
        ))}
      </div>

      <div className="profile-selector-container">
        {/* Logo */}
        <div className="profile-logo">
          <span className="profile-logo-icon">⚡</span>
          <span className="profile-logo-text">FlowBot AI</span>
        </div>

        {/* Title */}
        <h1 className="profile-title">{manageMode ? 'Manage Client Profiles' : "Who's automating?"}</h1>
        <p className="profile-subtitle">
          {manageMode
            ? 'Click any client profile below to delete them and their data'
            : 'Select a client profile to manage their automation'}
        </p>

        {/* Profile Grid */}
        <div className="profile-grid">
          {clients.map((client, i) => {
            const avatar = getAvatarStyle(i);
            const isHovered = hoveredId === client.id;
            return (
              <div
                key={client.id}
                className={`profile-card ${isHovered ? 'hovered' : ''} ${manageMode ? 'managing' : ''}`}
                onClick={() => manageMode ? deleteClient(client.id, client.name) : enterClient(client.id)}
                onMouseEnter={() => setHoveredId(client.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  position: 'relative',
                  border: manageMode ? '1px dashed rgba(239,68,68,0.5)' : undefined,
                }}
              >
                <div className="profile-avatar" style={{ background: avatar.bg }}>
                  <span className="profile-avatar-initials">{getInitials(client.name)}</span>
                  <div className="profile-avatar-glow" style={{ background: avatar.bg }} />
                </div>
                <div className="profile-card-name">{client.name}</div>
                {client.industry && (
                  <div className="profile-card-industry">{client.industry}</div>
                )}
                {!manageMode ? (
                  <div className="profile-card-stats-mini">
                    <span>📊 {client.leads_count || 0}</span>
                    <span>💬 {client.conversations_count || 0}</span>
                    <span>📅 {client.appointments_count || 0}</span>
                  </div>
                ) : (
                  <button
                    onClick={(e) => deleteClient(client.id, client.name, e)}
                    disabled={deletingId === client.id}
                    style={{
                      marginTop: 8,
                      padding: '5px 12px',
                      fontSize: 11,
                      fontWeight: 700,
                      background: 'rgba(239,68,68,0.2)',
                      color: '#ef4444',
                      border: '1px solid rgba(239,68,68,0.5)',
                      borderRadius: 6,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {deletingId === client.id ? 'Deleting...' : '🗑 Delete Client'}
                  </button>
                )}
              </div>
            );
          })}

          {/* Add New Client Card (hide when managing) */}
          {!manageMode && (
            <div
              className={`profile-card profile-card-add ${showCreate ? 'creating' : ''}`}
              onClick={() => !showCreate && setShowCreate(true)}
            >
              <div className="profile-avatar profile-avatar-add">
                <span className="profile-add-icon">+</span>
              </div>
              <div className="profile-card-name">Add Client</div>
            </div>
          )}
        </div>

        {/* Manage Profiles Toggle Button */}
        {clients.length > 0 && (
          <div style={{ marginTop: 32, display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={() => setManageMode(!manageMode)}
              style={{
                background: manageMode ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)',
                color: manageMode ? '#ef4444' : 'var(--text-secondary)',
                border: manageMode ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(255,255,255,0.15)',
                padding: '8px 24px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: 0.5,
                transition: 'all 0.2s',
              }}
            >
              {manageMode ? '✓ Done Managing' : '⚙️ Manage Profiles'}
            </button>
          </div>
        )}

        {/* Empty state for first-time users */}
        {clients.length === 0 && (
          <div className="profile-empty-hint">
            <p>Welcome to FlowBot AI! Create your first client to start automating.</p>
          </div>
        )}
      </div>

      {/* Create Client Modal */}
      {showCreate && (
        <div className="profile-modal-overlay" onClick={e => e.target === e.currentTarget && setShowCreate(false)}>
          <div className="profile-modal">
            <div className="profile-modal-header">
              <h2>Create New Client</h2>
              <button className="profile-modal-close" onClick={() => setShowCreate(false)}>✕</button>
            </div>

            <div className="profile-modal-body">
              <div className="profile-form-group">
                <label>Client / Business Name *</label>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Sharma Dental Clinic"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && createClient()}
                />
              </div>

              <div className="profile-form-row">
                <div className="profile-form-group">
                  <label>Industry</label>
                  <input
                    value={form.industry}
                    onChange={e => setForm(f => ({ ...f, industry: e.target.value }))}
                    placeholder="e.g. Healthcare"
                  />
                </div>
                <div className="profile-form-group">
                  <label>Location</label>
                  <input
                    value={form.location}
                    onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                    placeholder="e.g. Mumbai"
                  />
                </div>
              </div>

              <div className="profile-form-group">
                <label>Services</label>
                <textarea
                  value={form.services}
                  onChange={e => setForm(f => ({ ...f, services: e.target.value }))}
                  placeholder="List of services offered..."
                  rows={3}
                />
              </div>

              <p className="profile-form-hint">
                ✨ AI settings, working hours, and voice config will be auto-configured. Customize after creation.
              </p>
            </div>

            <div className="profile-modal-footer">
              <button className="profile-btn-cancel" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="profile-btn-create" onClick={createClient} disabled={creating}>
                {creating ? 'Creating...' : '⚡ Create & Enter'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
