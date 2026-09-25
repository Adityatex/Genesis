import { useState, useEffect } from 'react';
import { loadStoredProfile, saveStoredProfile, PROFILE_FIELDS, type AutofillProfile } from '@/lib/automation/profile';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '@/lib/api/providers';

type Status = 'idle' | 'saving' | 'saved' | 'error';

export default function App() {
  // AI provider settings. Keys stay in the background worker; the popup only
  // ever receives masked versions.
  const [provider, setProvider] = useState<ProviderId>('groq');
  const [savedModels, setSavedModels] = useState<Partial<Record<ProviderId, string>>>({});
  const [maskedKeys, setMaskedKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [profile, setProfile] = useState<AutofillProfile>({ fullname: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '' });
  const [profileStatus, setProfileStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [profileMessage, setProfileMessage] = useState('');

  useEffect(() => {
    browser.runtime.sendMessage({ action: 'GET_LLM_SETTINGS' }).then((res: any) => {
      if (!res?.success) return;
      const { provider: p, models, customBaseUrl: url, maskedKeys: masked } = res.data;
      setProvider(p);
      setSavedModels(models);
      setMaskedKeys(masked);
      setCustomBaseUrl(url);
      setModel(models[p] || PROVIDERS[p as ProviderId].defaultModel || '');
    });
    loadStoredProfile().then(setProfile).catch(() => {});
  }, []);

  const preset = PROVIDERS[provider];

  const showMessage = (s: Status, text: string) => {
    setStatus(s);
    setMessage(text);
  };

  const handleProviderChange = (p: ProviderId) => {
    setProvider(p);
    setModel(savedModels[p] || PROVIDERS[p].defaultModel || '');
    setApiKey('');
    setAvailableModels([]);
    showMessage('idle', '');
  };

  const handleLoadModels = async () => {
    setLoadingModels(true);
    showMessage('idle', '');
    try {
      const res = await browser.runtime.sendMessage({
        action: 'LIST_MODELS',
        payload: { provider, apiKey: apiKey.trim(), customBaseUrl: customBaseUrl.trim() },
      });
      if (!res?.success) throw new Error(res?.error || 'Could not load models');
      const models: string[] = res.data.models;
      setAvailableModels(models);
      showMessage(models.length ? 'saved' : 'error', models.length
        ? `${models.length} models available. Pick one in the Model field.`
        : `${preset.label} returned no models for this key.`);
    } catch (err: any) {
      showMessage('error', err.message);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleSave = async () => {
    if (preset.needsKey && !apiKey.trim() && !maskedKeys[provider]) {
      showMessage('error', `Enter your ${preset.label} API key`);
      return;
    }
    if (!model.trim()) {
      showMessage('error', 'Choose a model ("Load models" lists what your key can use)');
      return;
    }

    setStatus('saving');
    try {
      const res = await browser.runtime.sendMessage({
        action: 'SAVE_LLM_SETTINGS',
        payload: { provider, model: model.trim(), apiKey: apiKey.trim(), customBaseUrl: customBaseUrl.trim() },
      });
      if (!res?.success) throw new Error(res?.error || 'Failed to save');
      setMaskedKeys((m) => ({ ...m, [provider]: res.data.maskedKey }));
      setSavedModels((m) => ({ ...m, [provider]: model.trim() }));
      setApiKey('');
      showMessage('saved', `Saved. Genesis now uses ${preset.label} · ${model.trim()}`);
    } catch (err: any) {
      showMessage('error', err.message);
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

      {/* AI Provider Section */}
      <div className="section">
        <label className="section-label" htmlFor="provider">AI model</label>
        <select
          id="provider"
          className="api-input provider-select"
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
        >
          {PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>{PROVIDERS[id].label}</option>
          ))}
        </select>
        {(preset.note || preset.keyUrl) && (
          <p className="hint">
            {preset.note}{preset.note && preset.keyUrl ? ' ' : ''}
            {preset.keyUrl && <a href={preset.keyUrl} target="_blank" rel="noreferrer">Get a key</a>}
          </p>
        )}

        {provider === 'custom' && (
          <input
            type="url"
            placeholder="Server URL, e.g. https://host/v1"
            value={customBaseUrl}
            onChange={(e) => setCustomBaseUrl(e.target.value)}
            className="api-input"
          />
        )}

        {(preset.needsKey || provider === 'custom') && (
          <>
            {maskedKeys[provider] && (
              <div className="current-key">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                <span>{maskedKeys[provider]}</span>
              </div>
            )}
            <input
              type="password"
              placeholder={maskedKeys[provider]
                ? 'Paste a new key to replace it'
                : `Paste ${preset.label} API key${preset.needsKey ? '' : ' (if needed)'}...`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="api-input"
            />
          </>
        )}

        <div className="input-group">
          <input
            list="model-options"
            placeholder={preset.defaultModel ?? 'Model id'}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            className="api-input"
            aria-label="Model"
          />
          <datalist id="model-options">
            {availableModels.map((m) => <option key={m} value={m} />)}
          </datalist>
          <button onClick={handleLoadModels} className="secondary-btn" disabled={loadingModels} title="List the models your key can use">
            {loadingModels ? <span className="spinner"></span> : 'Load models'}
          </button>
        </div>

        <button onClick={handleSave} className="profile-save-btn" disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
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
