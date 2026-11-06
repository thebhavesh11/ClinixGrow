'use client';
import './globals.css';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import ProfileSelector from './components/ProfileSelector';
import { API, safeFetch } from './lib/utils';
import { ClientProvider, useClient } from './lib/ClientContext';

const NAV_ITEMS = [
  { section: 'MAIN' },
  { href: '/', icon: '◎', label: 'Dashboard' },
  { href: '/conversations', icon: '💬', label: 'Conversations', badgeKey: 'conversations' },
  { href: '/leads', icon: '🔥', label: 'Leads', badgeKey: 'leads' },
  { href: '/appointments', icon: '📅', label: 'Appointments', badgeKey: 'appointments' },
  { href: '/voice-agent', icon: '🎙️', label: 'Voice Agent' },
  { section: '' },
  { href: '/clients', icon: '👥', label: 'Manage Clients' },
  { href: '/businesses', icon: '🏢', label: 'Business Profile' },
  { href: '/whatsapp', icon: '📱', label: 'WhatsApp Web' },
  { href: '/automation', icon: '⚡', label: 'Automation' },
];

function AppShell({ children }) {
  const pathname = usePathname();
  const { clients, selectedClientId, selectedClient, selectClient, switchProfile, profileMode } = useClient();
  const [health, setHealth] = useState({ whatsapp: false, api: true });
  const [counts, setCounts] = useState({ conversations: 0, leads: 0, appointments: 0 });
  const [showClientDropdown, setShowClientDropdown] = useState(false);

  useEffect(() => {
    async function check() {
      if (!selectedClientId || profileMode) return;
      try {
        const [waData] = await safeFetch(`${API}/whatsapp/status?business_id=${selectedClientId}`);
        const [dashData] = await safeFetch(`${API}/dashboard?business_id=${selectedClientId}`);
        setHealth({ whatsapp: waData?.connected || false, api: true });
        if (dashData) setCounts({ conversations: dashData.active_conversations || 0, leads: dashData.total_leads || 0, appointments: dashData.appointments_today || 0 });
      } catch { setHealth(h => ({ ...h, api: false })); }
    }
    check();
    const iv = setInterval(check, 15000);
    return () => clearInterval(iv);
  }, [selectedClientId, profileMode]);

  // Client portal routes are completely standalone (no admin sidebar, no switcher)
  const isPortalRoute = pathname && pathname.startsWith('/portal');
  if (isPortalRoute) {
    return (
      <main style={{ minHeight: '100vh', height: '100vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: '#090d16' }}>
        {children}
      </main>
    );
  }

  // Show Netflix-style profile selector
  if (profileMode) {
    return <ProfileSelector />;
  }

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">⚡</div>
          <div className="brand-text"><h1>FlowBot AI</h1><p>WhatsApp Automation</p></div>
        </div>

        {/* Client Switcher */}
        <div className="client-switcher">
          <div className="client-switcher-label">CLIENT</div>
          <div className="client-switcher-dropdown" onClick={() => setShowClientDropdown(!showClientDropdown)}>
            <span className="client-switcher-name">{selectedClient?.name || 'Select Client'}</span>
            <span className="client-switcher-arrow">{showClientDropdown ? '▴' : '▾'}</span>
          </div>
          {showClientDropdown && (
            <div className="client-dropdown-menu">
              {clients.map(c => (
                <div
                  key={c.id}
                  className={`client-dropdown-item ${c.id === selectedClientId ? 'active' : ''}`}
                  onClick={() => { selectClient(c.id); setShowClientDropdown(false); }}
                >
                  <span className="client-dot"></span>
                  <div>
                    <div className="client-item-name">{c.name}</div>
                    {c.industry && <div className="client-item-industry">{c.industry}</div>}
                  </div>
                </div>
              ))}
              {/* Switch Profile option */}
              <div
                className="client-dropdown-item client-dropdown-switch"
                onClick={() => { setShowClientDropdown(false); switchProfile(); }}
              >
                <span style={{ fontSize: 14 }}>🔄</span>
                <div><div className="client-item-name">Switch Profile</div></div>
              </div>
            </div>
          )}
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item, i) => {
            if (item.section !== undefined) return <div key={`s${i}`} className="sidebar-section-label">{item.section}</div>;
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            const badge = item.badgeKey ? counts[item.badgeKey] : null;
            return (
              <Link href={item.href} key={item.href} className={`sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="link-icon">{item.icon}</span>{item.label}
                {badge > 0 && <span className="link-badge">{badge}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="issue-bar">
            <span className="issue-dot" style={{ background: !health.api ? 'var(--danger)' : !health.whatsapp ? 'var(--warning)' : 'var(--success)' }}></span>
            <div className="issue-text">
              <strong>{!health.api ? 'Issues Detected' : !health.whatsapp ? 'WhatsApp Offline' : 'All Systems OK'}</strong>
              <span>{!health.api ? 'Backend unreachable' : !health.whatsapp ? 'Connect in WhatsApp page' : 'No issues detected'}</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <div className="top-bar">
          <div className="status-badges">
            {selectedClient && (
              <span
                className="status-badge live"
                style={{ background: 'rgba(99, 102, 241, 0.1)', color: '#6366f1', cursor: 'pointer' }}
                onClick={switchProfile}
                title="Click to switch profile"
              >
                <span className="dot" style={{ background: '#6366f1' }}></span>
                {selectedClient.name}
                <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>🔄</span>
              </span>
            )}
            {!health.api && <span className="status-badge error"><span className="dot"></span>API Error</span>}
            <span className={`status-badge ${health.whatsapp ? 'live' : 'error'}`}><span className="dot"></span>{health.whatsapp ? 'WhatsApp Live' : 'WhatsApp Offline'}</span>
          </div>
        </div>
        <div className="page-body">
          <ErrorBoundary>{children}</ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <title>FlowBot AI — WhatsApp Automation</title>
        <meta name="description" content="AI-Powered WhatsApp Automation Platform" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
      </head>
      <body>
        <ClientProvider>
          <AppShell>{children}</AppShell>
        </ClientProvider>
      </body>
    </html>
  );
}
