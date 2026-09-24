import { useState, useEffect } from 'react';
import { loadStoredProfile, saveStoredProfile, PROFILE_FIELDS, type AutofillProfile } from '@/lib/automation/profile';

export default function App() {
  const [apiKey, setApiKey] = useState('');
  const [maskedKey, setMaskedKey] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [profile, setProfile] = useState<AutofillProfile>({ fullname: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '' });
  const [profileStatus, setProfileStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [profileMessage, setProfileMessage] = useState('');

  useEffect(() => {
    // Load current key status on mount
    browser.runtime.sendMessage({ action: 'GET_API_KEY' }).then((res: any) => {
      if (res?.success) {
        setMaskedKey(res.data.masked);
      }
    });
    loadStoredProfile().then(setProfile).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setStatus('error');
      setMessage('Please enter an API key');
      return;
    }

    setStatus('saving');
    try {
      const res = await browser.runtime.sendMessage({
        action: 'SET_API_KEY',
        payload: { apiKey: apiKey.trim() },
      });

      if (res?.success) {
        setStatus('saved');
        setMessage('API key saved successfully!');
        setMaskedKey(`${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`);
        setApiKey('');
        setTimeout(() => setStatus('idle'), 2000);
      } else {
        throw new Error(res?.error || 'Failed to save');
      }
    } catch (err: any) {
      setStatus('error');
      setMessage(err.message);
    }
  };

  const handleSaveProfile = async () => {
    setProfileStatus('saving');
    setProfileMessage('');
    try {
      await saveStoredProfile(profile);
      setProfileStatus('saved');
      setProfileMessage('Autofill profile saved on this device.');
      setTimeout(() => setProfileStatus('idle'), 2000);
    } catch (err: any) {
      setProfileStatus('error');
      setProfileMessage(err?.message || 'Failed to save profile');
    }
  };

  return (
    <div className="popup-container">
      {/* Header */}
      <div className="popup-header">
        <div className="logo-icon">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <defs>
              <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <circle cx="14" cy="14" r="13" stroke="url(#logoGrad)" strokeWidth="2" fill="none" />
            <text x="14" y="19" textAnchor="middle" fill="url(#logoGrad)" fontSize="16" fontWeight="bold" fontFamily="Inter, sans-serif">G</text>
          </svg>
        </div>
        <div>
          <h1 className="popup-title">Genesis</h1>
          <p className="popup-subtitle">AI Browser Assistant</p>
        </div>
      </div>

      {/* Status Badge */}
      <div className="status-badge">
        <div className="status-dot"></div>
        <span>Active on all pages</span>
      </div>

      {/* API Key Section */}
      <div className="section">
        <label className="section-label">Groq API Key</label>
        {maskedKey && (
          <div className="current-key">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            <span>{maskedKey}</span>
          </div>
        )}
        <div className="input-group">
          <input
            type="password"
            placeholder="Paste Groq API key..."
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setStatus('idle');
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            className="api-input"
          />
          <button onClick={handleSave} className="save-btn" disabled={status === 'saving'}>
            {status === 'saving' ? (
              <span className="spinner"></span>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        </div>
        {message && (
          <div className={`message ${status}`}>{message}</div>
        )}
      </div>

      {/* Autofill Profile Section */}
      <div className="section">
        <label className="section-label">Autofill Profile (stored locally)</label>
        <div className="profile-grid">
          {PROFILE_FIELDS.map((f) => (
            <label key={f.key} className="profile-field">
              <span className="profile-field-label">{f.label}</span>
              <input
                type={f.type || 'text'}
                placeholder={f.placeholder}
                value={profile[f.key]}
                onChange={(e) => {
                  setProfile((p) => ({ ...p, [f.key]: e.target.value }));
                  setProfileStatus('idle');
                }}
                className="api-input profile-input"
              />
            </label>
          ))}
        </div>
        <button onClick={handleSaveProfile} className="profile-save-btn" disabled={profileStatus === 'saving'}>
          {profileStatus === 'saving' ? 'Saving…' : 'Save profile'}
        </button>
        {profileMessage && (
          <div className={`message ${profileStatus}`}>{profileMessage}</div>
        )}
      </div>

      {/* Features List */}
      <div className="section">
        <label className="section-label">Capabilities</label>
        <div className="features-list">
          {[
            { icon: '📝', text: 'Extract page text' },
            { icon: '🔍', text: 'Detect form elements' },
            { icon: '✏️', text: 'Trustworthy auto-fill' },
            { icon: '📊', text: 'AI page summarization' },
            { icon: '💬', text: 'Copilot chat' },
            { icon: '🤖', text: 'Autonomous browser agent' },
          ].map((feature, i) => (
            <div key={i} className="feature-item">
              <span className="feature-icon">{feature.icon}</span>
              <span className="feature-text">{feature.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="popup-footer">
        <span>Sidebar opens automatically on every page</span>
      </div>
    </div>
  );
}
