'use client';
import { useState } from 'react';
import { API, safeFetch } from '../lib/utils';
import { useClient } from '../lib/ClientContext';

export default function ClientsPage() {
  const { clients, selectedClientId, selectClient, loadClients } = useClient();
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', industry: '', services: '', location: '' });
  const [toast, setToast] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [portalModal, setPortalModal] = useState(null);
  const [portalPin, setPortalPin] = useState('');
  const [savingPortal, setSavingPortal] = useState(false);

  async function createClient() {
    if (!form.name.trim()) { showToast('Client name is required', 'error'); return; }
    const [data, err] = await safeFetch(`${API}/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (err) { showToast(err, 'error'); return; }
    showToast(`Client "${form.name}" created!`, 'success');
    setShowModal(false);
    setForm({ name: '', industry: '', services: '', location: '' });
    await loadClients();
    if (data?.id) selectClient(data.id);
  }

  async function deleteClient(id, name) {
    if (!confirm(`Are you sure you want to delete "${name}"?\n\nThis will permanently remove ALL data:\n- Leads\n- Conversations & Messages\n- Appointments\n- Call Logs\n- AI Settings\n- Voice Settings\n\nThis action cannot be undone!`)) return;
    setDeleting(id);
    const [_, err] = await safeFetch(`${API}/clients/${id}`, { method: 'DELETE' });
    setDeleting(null);
    if (err) { showToast(err, 'error'); return; }
    showToast(`Client "${name}" deleted`, 'success');
    await loadClients();
  }

  function openPortalShare(client) {
    setPortalModal(client);
    setPortalPin('');
  }

  async function savePortalPin() {
    if (!portalModal) return;
    setSavingPortal(true);
    const [data, err] = await safeFetch(`${API}/clients/${portalModal.id}/portal-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portal_pin: portalPin }),
    });
    setSavingPortal(false);
    if (err) { showToast(err, 'error'); return; }
    showToast('Portal PIN updated!', 'success');
    setPortalModal(prev => ({ ...prev, has_portal_pin: Boolean(portalPin.trim()) }));
    await loadClients();
  }

  async function regeneratePortalLink() {
    if (!portalModal) return;
    if (!confirm('Regenerate portal link? The previous link will stop working immediately.')) return;
    setSavingPortal(true);
    const [data, err] = await safeFetch(`${API}/clients/${portalModal.id}/portal-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate_token: true }),
    });
    setSavingPortal(false);
    if (err) { showToast(err, 'error'); return; }
    showToast('New portal link generated!', 'success');
    setPortalModal(prev => ({ ...prev, portal_token: data.portal_token }));
    await loadClients();
  }

  function copyPortalUrl() {
    if (!portalModal?.portal_token) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = `${origin}/portal/${portalModal.portal_token}`;
    navigator.clipboard.writeText(url);
    showToast('Portal link copied to clipboard!', 'success');
  }

  function showToast(msg, type) { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); }

  return (<>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Manage Clients</h2>
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Create and manage client accounts. Each client has isolated data.</p>
      </div>
      <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ New Client</button>
    </div>

    {clients.length > 0 ? (
      <div className="client-cards-grid">
        {clients.map(c => (
          <div key={c.id} className={`client-card ${c.id === selectedClientId ? 'active' : ''}`} onClick={() => selectClient(c.id)}>
            {c.id === selectedClientId && <div className="client-active-badge">✓ Active</div>}
            <div className="client-card-name">{c.name}</div>
            <div className="client-card-industry">{c.industry || 'No industry set'} {c.location ? `• ${c.location}` : ''}</div>
            <div className="client-card-stats">
              <div className="client-stat"><div className="client-stat-value">{c.leads_count}</div><div className="client-stat-label">Leads</div></div>
              <div className="client-stat"><div className="client-stat-value">{c.conversations_count}</div><div className="client-stat-label">Convos</div></div>
              <div className="client-stat"><div className="client-stat-value">{c.appointments_count}</div><div className="client-stat-label">Appts</div></div>
              <div className="client-stat"><div className="client-stat-value">{c.messages_count}</div><div className="client-stat-label">Msgs</div></div>
            </div>
            <div className="client-card-actions">
              <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); selectClient(c.id); }} style={{ flex: 1 }}>
                {c.id === selectedClientId ? '✓ Selected' : 'Switch to'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); openPortalShare(c); }} title="Share Client Dashboard Link">
                🔗 Portal
              </button>
              <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); deleteClient(c.id, c.name); }} disabled={deleting === c.id} style={{ color: 'var(--danger)' }}>
                {deleting === c.id ? '...' : '🗑'}
              </button>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div className="empty-state">
        <div className="empty-icon">👥</div>
        <p>No clients yet. Create your first client to get started!</p>
        <button className="btn btn-primary" onClick={() => setShowModal(true)} style={{ marginTop: 16 }}>+ Create First Client</button>
      </div>
    )}

    {/* Create Client Modal */}
    {showModal && (
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
        <div className="modal-content">
          <div className="modal-header">
            <h3>Create New Client</h3>
            <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
          </div>
          <div className="form-group">
            <label className="form-label">Client / Business Name *</label>
            <input className="form-input" value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Sharma Dental Clinic" autoFocus />
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Industry</label>
              <input className="form-input" value={form.industry} onChange={e => setForm(f => ({...f, industry: e.target.value}))} placeholder="e.g. Healthcare" />
            </div>
            <div className="form-group">
              <label className="form-label">Location</label>
              <input className="form-input" value={form.location} onChange={e => setForm(f => ({...f, location: e.target.value}))} placeholder="e.g. Mumbai" />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Services</label>
            <textarea className="form-textarea" value={form.services} onChange={e => setForm(f => ({...f, services: e.target.value}))} placeholder="List of services..." rows={3} />
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            💡 AI settings, working hours, and voice settings will be auto-configured with defaults. You can customize them after creation.
          </p>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createClient}>👥 Create Client</button>
          </div>
        </div>
      </div>
    )}

    {/* Share Client Portal Modal */}
    {portalModal && (
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setPortalModal(null)}>
        <div className="modal-content" style={{ maxWidth: 520 }}>
          <div className="modal-header">
            <h3>🔗 Share Client Portal — {portalModal.name}</h3>
            <button className="modal-close" onClick={() => setPortalModal(null)}>✕</button>
          </div>

          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
            Share this dedicated link with your client. They can view live leads, monitor AI responses, and download reports — without accessing your admin panel or AI keys.
          </p>

          {/* Shareable Link Box */}
          <div className="form-group">
            <label className="form-label">Client Portal Magic Link</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="form-input"
                readOnly
                value={typeof window !== 'undefined' ? `${window.location.origin}/portal/${portalModal.portal_token}` : ''}
                style={{ background: 'var(--bg-secondary)', color: 'var(--accent)', fontWeight: 600, fontSize: 12 }}
              />
              <button className="btn btn-primary" onClick={copyPortalUrl} style={{ whiteSpace: 'nowrap' }}>
                📋 Copy Link
              </button>
            </div>
          </div>

          {/* Open in new tab button */}
          <div style={{ marginBottom: 24 }}>
            <a
              href={`/portal/${portalModal.portal_token}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary"
              style={{ width: '100%', textAlign: 'center', display: 'block', fontSize: 12 }}
            >
              👁️ Preview Client Portal (Opens in new tab)
            </a>
          </div>

          {/* Security PIN Setup */}
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            padding: 16,
            marginBottom: 20,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
              🛡️ Optional Security PIN {portalModal.has_portal_pin ? '✅ (Currently Active)' : '(Not Set)'}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 12 }}>
              Set a 4-digit PIN if you want the client to enter a passcode before viewing their dashboard. Leave blank to remove PIN.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="form-input"
                placeholder="e.g. 1234 (or leave blank to remove)"
                value={portalPin}
                onChange={e => setPortalPin(e.target.value)}
                maxLength={8}
                style={{ fontSize: 13 }}
              />
              <button
                className="btn btn-secondary"
                onClick={savePortalPin}
                disabled={savingPortal}
                style={{ whiteSpace: 'nowrap', fontSize: 12 }}
              >
                {savingPortal ? 'Saving...' : 'Set PIN'}
              </button>
            </div>
          </div>

          {/* Regenerate Token Danger Option */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, borderTop: '1px solid var(--border-color)' }}>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Need to revoke old link?
            </span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={regeneratePortalLink}
              disabled={savingPortal}
              style={{ color: 'var(--danger)', fontSize: 11 }}
            >
              🔄 Regenerate Secret Link
            </button>
          </div>
        </div>
      </div>
    )}

    {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
  </>);
}
