'use client';
import { useState, useEffect } from 'react';
import { API, safeFetch } from '../lib/utils';
import { useClient } from '../lib/ClientContext';
const PROVIDER_MODELS = { openai: ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-4','gpt-3.5-turbo','o1-mini','o3-mini'], gemini: ['gemini-2.0-flash','gemini-1.5-pro','gemini-1.5-flash','gemini-1.0-pro'], anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'], openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-1.5-flash', 'meta-llama/llama-3.1-8b-instruct', 'mistralai/mistral-nemo'] };

export default function Businesses() {
  const [biz, setBiz] = useState(null);
  const [ai, setAi] = useState(null);
  const [tab, setTab] = useState('info');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState(null);
  const [media, setMedia] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [editingMedia, setEditingMedia] = useState(null);
  const { bUrl, selectedClientId } = useClient();

  useEffect(() => {
    async function load() {
      const [b] = await safeFetch(bUrl('/business'));
      const [a] = await safeFetch(bUrl('/ai-settings'));
      const [m] = await safeFetch(bUrl('/media'));
      if (b) setBiz(b);
      if (a) setAi(a);
      if (Array.isArray(m)) setMedia(m);
      setLoading(false);
    }
    if (selectedClientId) load();
  }, [selectedClientId]);

  const showToast = (msg, type) => { setToast({ message: msg, type }); setTimeout(() => setToast(null), 3500); };
  const saveBusiness = async () => { setSaving(true); try { const [, err] = await safeFetch(bUrl('/business'), { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(biz) }); showToast(!err?'Business info saved!':'Failed to save', !err?'success':'error'); } finally { setSaving(false); } };
  const saveAI = async () => { setSaving(true); try { const [, err] = await safeFetch(bUrl('/ai-settings'), { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(ai) }); showToast(!err?'AI settings saved!':'Failed to save', !err?'success':'error'); } finally { setSaving(false); } };
  const testConnection = async () => { setValidating(true); setValidationStatus(null); try { const [d] = await safeFetch(`${API}/ai-settings/validate`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ provider:ai?.provider, api_key:ai?.api_key, model:ai?.model }) }); if (d) { setValidationStatus(d); showToast(d.valid?'✅ Connected!':'❌ '+d.message, d.valid?'success':'error'); } else { setValidationStatus({valid:false,message:'Connection failed'}); } } finally { setValidating(false); } };

  async function uploadFile(file) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', file.name.replace(/\.[^.]+$/, ''));
      fd.append('description', '');
      fd.append('business_id', String(selectedClientId || 1));
      const [m, err] = await safeFetch(`${API}/media/upload`, { method: 'POST', body: fd });
      if (m && !err) { setMedia(prev => [m, ...prev]); showToast('File uploaded!', 'success'); }
      else showToast('Upload failed', 'error');
    } catch { showToast('Upload error', 'error'); }
    finally { setUploading(false); }
  }

  if (loading) return <div className="loading"><div className="spinner"></div>Loading business profile...</div>;

  return (<>
    <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Business Profiles</h2>
    <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 24 }}>Configure AI behavior per business</p>
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Businesses</div>
        <div className="card" style={{ border: '2px solid var(--accent)', padding: 16 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🏢</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{biz?.name||'My Business'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>{biz?.industry||'No industry set'}</div>
          <span className="lead-badge" style={{ background:'rgba(16,185,129,0.12)', color:'var(--accent)', fontSize:10, padding:'2px 8px' }}><span className="badge-dot" style={{ background:'var(--accent)', width:5, height:5 }}></span>Active</span>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 32 }}>🏢</span>
          <div><div style={{ fontWeight: 700, fontSize: 18 }}>{biz?.name||'My Business'}</div><div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{biz?.industry||''}</div></div>
        </div>
        <div className="tabs" style={{ padding: '0 24px' }}>
          {['info','ai-agent','system-prompt','scoring-prompt','media','calendar'].map(t => (<div key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)}>{t==='info'?'Info':t==='ai-agent'?'AI Agent':t==='system-prompt'?'System Prompt':t==='scoring-prompt'?'Scoring Prompt':t==='media'?`Media (${media.length})`:'Calendar'}</div>))}
        </div>
        <div style={{ padding: 24 }}>
          {tab==='info' && biz && (<>
            <div className="grid-2"><div className="form-group"><label className="form-label">Business Name</label><input className="form-input" value={biz.name||''} onChange={e=>setBiz({...biz,name:e.target.value})} /></div><div className="form-group"><label className="form-label">Industry</label><input className="form-input" value={biz.industry||''} onChange={e=>setBiz({...biz,industry:e.target.value})} /></div></div>
            <div className="grid-2"><div className="form-group"><label className="form-label">Location</label><input className="form-input" value={biz.location||''} onChange={e=>setBiz({...biz,location:e.target.value})} /></div><div className="form-group"><label className="form-label">Working Hours</label><input className="form-input" value={biz.working_hours||''} onChange={e=>setBiz({...biz,working_hours:e.target.value})} /></div></div>
            <div className="form-group"><label className="form-label">Business Information (AI Knowledge Base)</label><textarea className="form-textarea" style={{ minHeight: 100 }} value={biz.services||''} onChange={e=>setBiz({...biz,services:e.target.value})} /></div>
            <div className="form-group"><label className="form-label">Pricing</label><textarea className="form-textarea" style={{ minHeight: 80 }} value={biz.pricing||''} onChange={e=>setBiz({...biz,pricing:e.target.value})} /></div>
            <div className="form-group"><label className="form-label">Current Offers</label><textarea className="form-textarea" style={{ minHeight: 60 }} value={biz.offers||''} onChange={e=>setBiz({...biz,offers:e.target.value})} /></div>
            <div className="form-group"><label className="form-label">FAQs</label><textarea className="form-textarea" style={{ minHeight: 80 }} value={biz.faqs||''} onChange={e=>setBiz({...biz,faqs:e.target.value})} /></div>
            <button className="btn btn-primary" onClick={saveBusiness} disabled={saving}>{saving?'⏳ Saving...':'Save Changes'}</button>
          </>)}
          {tab==='ai-agent' && ai && (<>
            <div className="grid-2">
              <div className="form-group"><label className="form-label">AI Provider</label><select className="form-select" value={ai.provider} onChange={e=>{const p=e.target.value;setAi({...ai,provider:p,model:p==='openai'?'gpt-4o-mini':p==='gemini'?'gemini-1.5-flash':p==='anthropic'?'claude-3-5-sonnet-20241022':''});setValidationStatus(null);}}><option value="openai">OpenAI</option><option value="gemini">Google Gemini</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option></select></div>
              <div className="form-group"><label className="form-label">AI Model</label><input className="form-input" list="ai-models-list" placeholder="Select or type a model..." value={ai.model||''} onChange={e=>setAi({...ai,model:e.target.value})} /><datalist id="ai-models-list">{(PROVIDER_MODELS[ai.provider]||[]).map(m=><option key={m} value={m} />)}</datalist></div>
            </div>
            <div className="form-group"><label className="form-label">API Key</label><div style={{ display: 'flex', gap: 10 }}><input className="form-input" type="password" placeholder="Enter your API key..." value={ai.api_key||''} onChange={e=>{setAi({...ai,api_key:e.target.value});setValidationStatus(null);}} style={{ flex:1 }} /><button className="btn btn-secondary" onClick={testConnection} disabled={validating||!ai?.api_key}>{validating?'⏳ Testing...':'🔌 Test Connection'}</button></div>
              {validationStatus && <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 'var(--radius-sm)', fontSize: 12, fontWeight: 600, background: validationStatus.valid?'rgba(16,185,129,0.1)':'rgba(239,68,68,0.1)', color: validationStatus.valid?'var(--success)':'var(--danger)', border: `1px solid ${validationStatus.valid?'rgba(16,185,129,0.2)':'rgba(239,68,68,0.2)'}` }}>{validationStatus.valid?'✅':'❌'} {validationStatus.message}</div>}
            </div>
            <div className="grid-2"><div className="form-group"><label className="form-label">Temperature ({ai.temperature})</label><input type="range" min="0" max="2" step="0.1" value={ai.temperature} onChange={e=>setAi({...ai,temperature:parseFloat(e.target.value)})} style={{ width: '100%', accentColor: 'var(--accent)' }} /></div><div className="form-group"><label className="form-label">Max Tokens</label><input className="form-input" type="number" value={ai.max_tokens} onChange={e=>setAi({...ai,max_tokens:parseInt(e.target.value)||500})} /></div></div>
            <button className="btn btn-primary" onClick={saveAI} disabled={saving}>{saving?'⏳ Saving...':'Save Agent Config'}</button>
          </>)}
          {tab==='system-prompt' && ai && (<>
            <div className="form-group"><label className="form-label">Response AI System Prompt</label><textarea className="form-textarea" style={{ minHeight: 180 }} placeholder="You are a professional customer assistant..." value={ai.system_prompt||''} onChange={e=>setAi({...ai,system_prompt:e.target.value})} /><p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>This prompt controls how the AI agent responds. Business info is appended as reference data automatically.</p></div>
            <button className="btn btn-primary" onClick={saveAI} disabled={saving}>{saving?'⏳ Saving...':'Save Prompts'}</button>
          </>)}
          {tab==='scoring-prompt' && ai && (<>
            <div className="form-group"><label className="form-label">Lead Scoring System Prompt</label><textarea className="form-textarea" style={{ minHeight: 200 }} placeholder={"Analyze this conversation and score the lead from 0-100.\n\nScoring criteria:\n- HOT (80-100): Ready to buy, has budget clarity, shows urgency\n- WARM (50-79): Interested but comparing options, needs nurturing\n- COLD (0-49): Just browsing, no budget mentioned, vague interest"} value={ai.scoring_prompt||''} onChange={e=>setAi({...ai,scoring_prompt:e.target.value})} /><p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6, lineHeight: 1.7 }}>This prompt tells the AI how to score leads. The conversation history is appended automatically.<br/>The AI must return a JSON: <code style={{ background: 'var(--bg-input)', padding: '2px 6px', borderRadius: 4 }}>{'{"score": number, "label": "hot|warm|cold"}'}</code><br/>Leave empty to use the default scoring criteria.</p></div>
            <button className="btn btn-primary" onClick={saveAI} disabled={saving}>{saving?'⏳ Saving...':'Save Scoring Prompt'}</button>
          </>)}
          {tab==='media' && <MediaTab media={media} setMedia={setMedia} uploading={uploading} editingMedia={editingMedia} setEditingMedia={setEditingMedia} uploadFile={uploadFile} showToast={showToast} />}
          {tab==='calendar' && <div className="empty-state"><div className="empty-icon">📅</div><p>Calendar integration coming soon. Connect Google Calendar or Cal.com for appointment booking.</p></div>}
        </div>
      </div>
    </div>
    {toast && <div className={`toast toast-${toast.type}`}>{toast.type==='success'?'✅':'❌'} {toast.message}</div>}
  </>);
}

function MediaTab({ media, setMedia, uploading, editingMedia, setEditingMedia, uploadFile, showToast }) {
  return (<>
    <div style={{ marginBottom: 20 }}>
      <label className="form-label">Upload Media</label>
      <div style={{ border: '2px dashed var(--border-color)', borderRadius: 'var(--radius)', padding: 24, textAlign: 'center', cursor: 'pointer', background: 'var(--bg-secondary)', transition: 'border-color 0.2s' }} onClick={() => document.getElementById('media-upload')?.click()} onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent)'; }} onDragLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }} onDrop={async e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--border-color)'; for (const f of e.dataTransfer.files) { await uploadFile(f); } }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>📎</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{uploading ? '⏳ Uploading...' : 'Click or drag files here to upload'}</div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Images (JPG, PNG, WebP) • PDF • Videos (MP4, MOV)</div>
      </div>
      <input id="media-upload" type="file" accept="image/*,video/*,.pdf" multiple hidden onChange={async e => { for (const f of e.target.files) { await uploadFile(f); } e.target.value = ''; }} />
    </div>
    {media.length === 0 ? (<div className="empty-state"><div className="empty-icon">📁</div><p>No media files yet. Upload images, PDFs, or videos for the AI to share with customers.</p></div>) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {media.map(m => (
          <div key={m.id} style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius)', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
            <div style={{ height: 120, background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              {m.file_type === 'image' ? <img src={`${API}/media/file/${m.id}`} alt={m.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ fontSize: 40 }}>{m.file_type === 'pdf' ? '📄' : '🎬'}</div>}
              <span style={{ position: 'absolute', top: 8, right: 8, background: m.file_type === 'image' ? 'rgba(59,130,246,0.8)' : m.file_type === 'pdf' ? 'rgba(239,68,68,0.8)' : 'rgba(168,85,247,0.8)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 8, textTransform: 'uppercase' }}>{m.file_type}</span>
            </div>
            <div style={{ padding: 12 }}>
              {editingMedia === m.id ? (<>
                <input className="form-input" value={m.name} onChange={e => setMedia(media.map(x => x.id === m.id ? { ...x, name: e.target.value } : x))} style={{ marginBottom: 8, fontSize: 12 }} placeholder="File name" />
                <textarea className="form-textarea" value={m.description || ''} onChange={e => setMedia(media.map(x => x.id === m.id ? { ...x, description: e.target.value } : x))} style={{ minHeight: 50, fontSize: 11 }} placeholder="When should AI send this?" />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }} onClick={async () => { await safeFetch(`${API}/media/${m.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: m.name, description: m.description }) }); setEditingMedia(null); showToast('Media updated!', 'success'); }}>Save</button>
                  <button className="btn btn-secondary" style={{ fontSize: 11, padding: '4px 12px' }} onClick={() => setEditingMedia(null)}>Cancel</button>
                </div>
              </>) : (<>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{m.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>{m.original_filename}</div>
                {m.description && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, fontStyle: 'italic' }}>{m.description}</div>}
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8 }}>Tag: <code style={{ background: 'var(--bg-input)', padding: '1px 4px', borderRadius: 3 }}>[MEDIA:{m.id}]</code></div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-secondary" style={{ fontSize: 11, padding: '4px 12px' }} onClick={() => setEditingMedia(m.id)}>✏️ Edit</button>
                  <button className="btn btn-secondary" style={{ fontSize: 11, padding: '4px 12px', color: 'var(--danger)' }} onClick={async () => { if (!confirm('Delete this file?')) return; await safeFetch(`${API}/media/${m.id}`, { method: 'DELETE' }); setMedia(media.filter(x => x.id !== m.id)); showToast('File deleted', 'success'); }}>🗑️</button>
                </div>
              </>)}
            </div>
          </div>
        ))}
      </div>
    )}
  </>);
}
