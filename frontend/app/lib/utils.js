/**
 * Shared utility functions for FlowBot AI frontend.
 * Centralized here to avoid duplication across pages.
 */

/** API base path — all pages use this consistently */
export const API = '/api';

/**
 * Safe fetch wrapper — handles network errors, non-JSON responses, and timeouts gracefully.
 * Returns [data, error] tuple. Never throws.
 */
export async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return [null, `HTTP ${response.status}: ${text.slice(0, 200)}`];
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return [data, null];
    }

    // Non-JSON response — return text
    const text = await response.text();
    return [text, null];
  } catch (err) {
    if (err.name === 'AbortError') {
      return [null, 'Request timed out'];
    }
    return [null, err.message || 'Network error'];
  }
}

/**
 * Human-readable relative time string.
 * @param {string|Date} dt - ISO date string or Date object
 */
export function timeAgo(dt) {
  if (!dt) return '';
  // Fix for SQLAlchemy naive datetimes — treat as UTC
  const dateStr = (typeof dt === 'string' && !dt.endsWith('Z') && !dt.includes('+')) ? dt + 'Z' : dt;
  const m = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Get CSS color variable for a lead score.
 * @param {number} score - Lead score 0-100
 */
export function scoreColor(score) {
  if (score >= 80) return 'var(--hot)';
  if (score >= 50) return 'var(--warm)';
  return 'var(--cold)';
}

/**
 * Format a datetime into standard WhatsApp format (Today HH:MM, Yesterday, Weekday, or DD/MM/YY).
 * @param {string|Date|number} dt - ISO date string, Date object, or epoch ms
 */
export function formatWhatsAppTime(dt) {
  if (!dt) return '';
  let d;
  if (typeof dt === 'number') {
    d = new Date(dt);
  } else {
    const dateStr = (typeof dt === 'string' && !dt.endsWith('Z') && !dt.includes('+')) ? dt + 'Z' : dt;
    d = new Date(dateStr);
  }
  if (isNaN(d.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - targetDate) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'short' });
  } else {
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
}

/**
 * Format a datetime to time string (HH:MM).
 * @param {string|Date} dt - ISO date string or Date object
 */
export function formatTime(dt) {
  if (!dt) return '';
  const dateStr = (typeof dt === 'string' && !dt.endsWith('Z') && !dt.includes('+')) ? dt + 'Z' : dt;
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
