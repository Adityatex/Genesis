import { useState, useEffect } from 'react';
import { loadStoredProfile, saveStoredProfile, PROFILE_FIELDS, type AutofillProfile } from '@/lib/automation/profile';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '@/lib/api/providers';
import type { ModelInfo } from '@/lib/api/llmClient';
import { CHECKPOINT_CHOICES, PARALLEL_CHOICES, DEFAULT_PREFS, type ScreenshotMode } from '@/lib/agent/prefs';

const TASK_ICON: Record<string, string> = { running: '⏳', queued: '🕒', paused: '⏸️', done: '✅', error: '❌', stopped: '⏹️' };

interface TaskRow { tabId: number; goal: string; status: string; step: number; title?: string; model?: string; background?: boolean }
import type { BridgeStatus } from '@/lib/mcp/bridgeClient';
import { formatSkill, type Skill } from '@/lib/skills/skill';
import type { Workflow } from '@/lib/workflows/workflow';
import { blanks, type Shortcut } from '@/lib/shortcuts/shortcut';
import { describeFrequency, type Frequency, type Schedule } from '@/lib/schedules/schedule';

const MCP_STATUS_TEXT: Record<BridgeStatus, string> = {
  off: 'Off',
  waiting: 'On. Waiting for genesis-mcp: it starts when your AI app uses Genesis',
  connected: 'Connected to your AI app',
  rejected: 'Not connected',
};

interface McpState { enabled: boolean; hasToken: boolean; status: BridgeStatus; detail?: string }

type Status = 'idle' | 'saving' | 'saved' | 'error';

export default function App() {
  // AI provider settings. Keys stay in the background worker; the popup only
  // ever receives masked versions.
  const [provider, setProvider] = useState<ProviderId>('groq');
  // The provider Genesis uses (the dropdown may show another one being set up)
  const [activeProvider, setActiveProvider] = useState<ProviderId>('groq');
  const [fallbacks, setFallbacks] = useState<ProviderId[]>([]);
  // Providers with a key and model saved
  const [ready, setReady] = useState<ProviderId[]>([]);
  const [executorProvider, setExecutorProvider] = useState<ProviderId | ''>('');
  const [executorModel, setExecutorModel] = useState('');
  const [executorMessage, setExecutorMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedModels, setSavedModels] = useState<Partial<Record<ProviderId, string>>>({});
  const [maskedKeys, setMaskedKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [trustedInput, setTrustedInput] = useState(true);
  const [stepCheckpoint, setStepCheckpoint] = useState(DEFAULT_PREFS.stepCheckpoint);
  const [screenshots, setScreenshots] = useState<ScreenshotMode>(DEFAULT_PREFS.screenshots);
  const [nativeTools, setNativeTools] = useState(DEFAULT_PREFS.nativeTools);
  const [customCode, setCustomCode] = useState(DEFAULT_PREFS.customCode);
  const [maxParallel, setMaxParallel] = useState(DEFAULT_PREFS.maxParallel);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [mcp, setMcp] = useState<McpState>({ enabled: false, hasToken: false, status: 'off' });
  const [mcpToken, setMcpToken] = useState('');
  const [mcpError, setMcpError] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  // original: the name of the shortcut being edited, so a rename replaces it
  const [shortcutDraft, setShortcutDraft] = useState<{ name: string; prompt: string; original?: string }>({ name: '', prompt: '' });
  const [shortcutMessage, setShortcutMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleDraft, setScheduleDraft] = useState({ target: '', url: '', args: '', frequency: 'daily' as Frequency, time: '09:00', weekday: 1 });
  const [scheduleMessage, setScheduleMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Blanks of the shortcut picked for a schedule, which need words
  const draftShortcut = shortcuts.find((sc) => `shortcut:${sc.name}` === scheduleDraft.target);
  const draftBlanks = draftShortcut ? blanks(draftShortcut.prompt) : [];
  const [workflowMessage, setWorkflowMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [skillDraft, setSkillDraft] = useState('');
  const [skillMessage, setSkillMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [profile, setProfile] = useState<AutofillProfile>({ fullname: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '' });
  const [profileStatus, setProfileStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [profileMessage, setProfileMessage] = useState('');

  useEffect(() => {
    browser.runtime.sendMessage({ action: 'GET_LLM_SETTINGS' }).then((res: any) => {
      if (!res?.success) return;
      const { provider: p, models, customBaseUrl: url, maskedKeys: masked, fallbacks: backups, ready: readyIds, executor } = res.data;
      setReady(readyIds ?? []);
      setExecutorProvider(executor?.provider ?? '');
      setExecutorModel(executor?.model ?? '');
      setProvider(p);
      setActiveProvider(p);
      setFallbacks(backups ?? []);
      setSavedModels(models);
      setMaskedKeys(masked);
      setCustomBaseUrl(url);
      setModel(models[p] || PROVIDERS[p as ProviderId].defaultModel || '');
    });
    browser.runtime.sendMessage({ action: 'GET_PREFS' }).then((res: any) => {
      if (!res?.success) return;
      setTrustedInput(res.data.trustedInput);
      setStepCheckpoint(res.data.stepCheckpoint);
      setScreenshots(res.data.screenshots);
      setNativeTools(res.data.nativeTools);
      setCustomCode(res.data.customCode);
      setMaxParallel(res.data.maxParallel);
    });
    loadStoredProfile().then(setProfile).catch(() => {});
    // Connection status changes while the popup is open (an AI app starts genesis-mcp)
    const refreshMcp = () => browser.runtime.sendMessage({ action: 'GET_MCP' }).then((res: any) => { if (res?.success) setMcp(res.data); }).catch(() => {});
    refreshMcp();
    // The task list follows what the agent is doing while the popup is open
    const refreshTasks = () => browser.runtime.sendMessage({ action: 'LIST_TASKS' }).then((res: any) => { if (res?.success) setTasks(res.data); }).catch(() => {});
    refreshTasks();
    const tasksTimer = setInterval(refreshTasks, 2000);
    browser.runtime.sendMessage({ action: 'LIST_SCHEDULES' }).then((res: any) => { if (res?.success) setSchedules(res.data); }).catch(() => {});
    browser.runtime.sendMessage({ action: 'LIST_SHORTCUTS' }).then((res: any) => { if (res?.success) setShortcuts(res.data); }).catch(() => {});
    browser.runtime.sendMessage({ action: 'LIST_WORKFLOWS' }).then((res: any) => { if (res?.success) setWorkflows(res.data); }).catch(() => {});
    browser.runtime.sendMessage({ action: 'LIST_SKILLS' }).then((res: any) => { if (res?.success) setSkills(res.data); }).catch(() => {});
    const mcpTimer = setInterval(refreshMcp, 2000);
    return () => { clearInterval(mcpTimer); clearInterval(tasksTimer); };
  }, []);

  const handleTrustedInputChange = async (on: boolean) => {
    setTrustedInput(on);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_PREFS', payload: { trustedInput: on } });
    if (!res?.success) setTrustedInput(!on);
  };

  const handleSaveSkill = async () => {
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_SKILL', payload: { text: skillDraft } });
    if (!res?.success) {
      setSkillMessage({ ok: false, text: res?.error || 'Could not save the skill' });
      return;
    }
    setSkills(res.data);
    setSkillDraft('');
    setSkillMessage({ ok: true, text: 'Skill saved.' });
  };

  const handleSaveSchedule = async () => {
    const [kind, ...rest] = scheduleDraft.target.split(':');
    const { url, args, frequency, time, weekday } = scheduleDraft;
    const res: any = await browser.runtime.sendMessage({
      action: 'SAVE_SCHEDULE',
      payload: { kind, name: rest.join(':'), url, args, frequency, time, weekday },
    });
    if (!res?.success) {
      setScheduleMessage({ ok: false, text: res?.error || 'Could not save it' });
      return;
    }
    setSchedules(res.data);
    setScheduleDraft((d) => ({ ...d, target: '', url: '', args: '' }));
    setScheduleMessage({ ok: true, text: 'Scheduled.' });
  };

  const handleToggleSchedule = async (id: string, enabled: boolean) => {
    const res: any = await browser.runtime.sendMessage({ action: 'TOGGLE_SCHEDULE', payload: { id, enabled } });
    if (res?.success) setSchedules(res.data);
  };

  const handleRunScheduleNow = async (id: string) => {
    const res: any = await browser.runtime.sendMessage({ action: 'RUN_SCHEDULE_NOW', payload: { id } });
    setScheduleMessage(res?.success
      ? { ok: true, text: 'Running in a background tab; a notification will say how it went.' }
      : { ok: false, text: res?.error || 'Could not run it' });
  };

  const handleDeleteSchedule = async (id: string) => {
    const res: any = await browser.runtime.sendMessage({ action: 'DELETE_SCHEDULE', payload: { id } });
    if (res?.success) setSchedules(res.data);
  };

  const handleSaveShortcut = async () => {
    const { original, ...draft } = shortcutDraft;
    let res: any = await browser.runtime.sendMessage({ action: 'SAVE_SHORTCUT', payload: draft });
    if (!res?.success) {
      setShortcutMessage({ ok: false, text: res?.error || 'Could not save it' });
      return;
    }
    // Renamed while editing: drop the old one
    if (original && !res.data.some((sc: Shortcut) => sc.name === original && sc.prompt === draft.prompt.trim())) {
      const renamed = res.data.find((sc: Shortcut) => sc.prompt === draft.prompt.trim() && sc.name !== original);
      if (renamed) res = await browser.runtime.sendMessage({ action: 'DELETE_SHORTCUT', payload: { name: original } });
    }
    setShortcuts(res.data);
    setShortcutDraft({ name: '', prompt: '' });
    setShortcutMessage({ ok: true, text: 'Saved. Type / in the sidebar to use it.' });
  };

  const handleDeleteShortcut = async (name: string) => {
    const res: any = await browser.runtime.sendMessage({ action: 'DELETE_SHORTCUT', payload: { name } });
    if (res?.success) setShortcuts(res.data);
  };

  const handleRunWorkflow = async (name: string) => {
    const res: any = await browser.runtime.sendMessage({ action: 'RUN_WORKFLOW', payload: { name } });
    if (!res?.success) {
      setWorkflowMessage({ ok: false, text: res?.error || 'Could not run it' });
      return;
    }
    window.close(); // the page's sidebar shows the replay
  };

  const handleDeleteWorkflow = async (name: string) => {
    const res: any = await browser.runtime.sendMessage({ action: 'DELETE_WORKFLOW', payload: { name } });
    if (res?.success) setWorkflows(res.data);
  };

  const handleDeleteSkill = async (name: string) => {
    const res: any = await browser.runtime.sendMessage({ action: 'DELETE_SKILL', payload: { name } });
    if (res?.success) setSkills(res.data);
  };

  const saveMcp = async (change: { enabled?: boolean; token?: string }) => {
    setMcpError('');
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_MCP', payload: change });
    if (!res?.success) {
      setMcpError(res?.error || 'Could not save');
      return;
    }
    setMcp(res.data);
    if (change.token) setMcpToken('');
  };

  const handleTask = async (tabId: number, op: 'open' | 'stop' | 'continue') => {
    await browser.runtime.sendMessage({ action: 'TASK_CONTROL', payload: { tabId, op } }).catch(() => {});
    if (op === 'open') window.close();
  };

  const handleMaxParallelChange = async (n: number) => {
    const previous = maxParallel;
    setMaxParallel(n);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_PREFS', payload: { maxParallel: n } });
    if (!res?.success) setMaxParallel(previous);
  };

  const handleCustomCodeChange = async (on: boolean) => {
    setCustomCode(on);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_PREFS', payload: { customCode: on } });
    if (!res?.success) setCustomCode(!on);
  };

  const handleNativeToolsChange = async (on: boolean) => {
    setNativeTools(on);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_PREFS', payload: { nativeTools: on } });
    if (!res?.success) setNativeTools(!on);
  };

  const handleScreenshotsChange = async (mode: ScreenshotMode) => {
    const previous = screenshots;
    setScreenshots(mode);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_PREFS', payload: { screenshots: mode } });
    if (!res?.success) setScreenshots(previous);
  };

  const handleCheckpointChange = async (steps: number) => {
    const previous = stepCheckpoint;
    setStepCheckpoint(steps);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_PREFS', payload: { stepCheckpoint: steps } });
    if (!res?.success) setStepCheckpoint(previous);
  };

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
      const models: ModelInfo[] = res.data.models;
      setAvailableModels(models);
      const free = models.filter((m) => m.free).length;
      showMessage(models.length ? 'saved' : 'error', models.length
        ? `${models.length} models available${free ? ` (${free} free, listed first)` : ''}. Pick one in the Model field.`
        : `${preset.label} returned no usable models for this key.`);
    } catch (err: any) {
      showMessage('error', err.message);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleSaveExecutor = async (p: ProviderId | '', m: string) => {
    const res: any = await browser.runtime.sendMessage({
      action: 'SAVE_EXECUTOR',
      payload: { executor: p ? { provider: p, model: m.trim() } : null },
    });
    if (!res?.success) setExecutorMessage({ ok: false, text: res?.error || 'Could not save' });
    else setExecutorMessage({ ok: true, text: p ? `Routine steps now go to ${PROVIDERS[p].label} · ${m.trim()}.` : 'Off: your main model takes every step.' });
  };

  const handleRemoveBackup = async (id: ProviderId) => {
    const next = fallbacks.filter((f) => f !== id);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_FALLBACKS', payload: { fallbacks: next } });
    if (res?.success) setFallbacks(res.data.fallbacks);
  };

  /** Save the dropdown's provider, as the one Genesis uses or as a backup. */
  const handleSave = async (asBackup = false) => {
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
        payload: { provider, model: model.trim(), apiKey: apiKey.trim(), customBaseUrl: customBaseUrl.trim(), asBackup },
      });
      if (!res?.success) throw new Error(res?.error || 'Failed to save');
      setActiveProvider(res.data.provider);
      setFallbacks(res.data.fallbacks ?? []);
      setReady((r) => (r.includes(provider) ? r : [...r, provider]));
      setMaskedKeys((m) => ({ ...m, [provider]: res.data.maskedKey }));
      setSavedModels((m) => ({ ...m, [provider]: model.trim() }));
      setApiKey('');
      showMessage('saved', asBackup
        ? `Saved. ${preset.label} · ${model.trim()} is backup #${res.data.fallbacks.indexOf(provider) + 1}.`
        : `Saved. Genesis now uses ${preset.label} · ${model.trim()}`);
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

      {/* Tasks Section: the agent's tasks in every tab */}
      {tasks.length > 0 && (
        <div className="section">
          <label className="section-label">Tasks</label>
          <ul className="skill-list">
            {tasks.map((t) => (
              <li key={t.tabId}>
                <div className="skill-head">
                  <span>{TASK_ICON[t.status] ?? '•'}</span>
                  <strong className="task-goal" title={t.goal}>{t.goal || t.title}</strong>
                  <span className="skill-actions">
                    <button className="link-btn" onClick={() => handleTask(t.tabId, 'open')}>Open</button>
                    {t.status === 'paused' && <button className="link-btn" onClick={() => handleTask(t.tabId, 'continue')}>Continue</button>}
                    {['running', 'queued', 'paused'].includes(t.status) && (
                      <button className="link-btn" onClick={() => handleTask(t.tabId, 'stop')}>Stop</button>
                    )}
                  </span>
                </div>
                <div className="skill-desc">
                  {t.status === 'running' ? `Step ${t.step}` : t.status === 'queued' ? 'Waiting for a free slot' : t.status}
                  {t.background ? ' · background tab' : ''}{t.model ? ` · ${t.model}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

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
                : `Paste ${preset.label} API key${preset.needsKey ? '' : ' (optional)'}...`}
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
            onKeyDown={(e) => e.key === 'Enter' && handleSave(provider !== activeProvider && fallbacks.includes(provider))}
            className="api-input"
            aria-label="Model"
          />
          <datalist id="model-options">
            {availableModels.map((m) => (
              <option
                key={m.id}
                value={m.id}
                label={[m.free && 'free', m.mayTrain && 'may train on your data'].filter(Boolean).join(' · ') || undefined}
              />
            ))}
          </datalist>
          <button onClick={handleLoadModels} className="secondary-btn" disabled={loadingModels} title="List the models your key can use">
            {loadingModels ? <span className="spinner"></span> : 'Load models'}
          </button>
        </div>

        {provider === activeProvider ? (
          <button onClick={() => handleSave()} className="profile-save-btn" disabled={status === 'saving'}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        ) : (
          <div className="input-group">
            <button onClick={() => handleSave()} className="profile-save-btn" disabled={status === 'saving'}>
              Use as main
            </button>
            <button onClick={() => handleSave(true)} className="secondary-btn" disabled={status === 'saving'}>
              {fallbacks.includes(provider) ? 'Update backup' : 'Save as backup'}
            </button>
          </div>
        )}
        {message && (
          <div className={`message ${status}`}>{message}</div>
        )}

        <label className="section-label" style={{ marginTop: 12 }}>Backups</label>
        {fallbacks.length > 0 ? (
          <ol className="backup-list">
            {fallbacks.map((id) => (
              <li key={id}>
                <span>{PROVIDERS[id].label} · {savedModels[id] || PROVIDERS[id].defaultModel}</span>
                <button onClick={() => handleRemoveBackup(id)} className="link-btn" title="Remove this backup">Remove</button>
              </li>
            ))}
          </ol>
        ) : null}
        <p className="hint">
          {fallbacks.length
            ? `When ${PROVIDERS[activeProvider].label} hits a rate limit or fails, the next backup takes over mid-task with the same plan and progress. Genesis goes back to ${PROVIDERS[activeProvider].label} when it's available again.`
            : 'No backups. To add one, pick another provider above, enter its key and model, and press "Save as backup". When your main provider hits a rate limit, the backup takes over mid-task.'}
        </p>

        <label className="section-label" style={{ marginTop: 12 }} htmlFor="executor-provider">Fast model for routine steps</label>
        <div className="input-group">
          <select
            id="executor-provider"
            className="api-input"
            style={{ flex: '0 0 40%' }}
            value={executorProvider}
            onChange={(e) => {
              const p = e.target.value as ProviderId | '';
              setExecutorProvider(p);
              if (!p) handleSaveExecutor('', '');
            }}
          >
            <option value="">Off</option>
            {ready.map((id) => <option key={id} value={id}>{PROVIDERS[id].label}</option>)}
          </select>
          {executorProvider && (
            <>
              <input
                placeholder="Model id"
                value={executorModel}
                onChange={(e) => setExecutorModel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveExecutor(executorProvider, executorModel)}
                className="api-input"
                aria-label="Fast model"
              />
              <button onClick={() => handleSaveExecutor(executorProvider, executorModel)} className="secondary-btn">Save</button>
            </>
          )}
        </div>
        {executorMessage && <div className={`message ${executorMessage.ok ? 'saved' : 'error'}`}>{executorMessage.text}</div>}
        <p className="hint">
          Optional. A quick, cheap model takes the routine steps; your main model makes the plan, steps in when something
          goes wrong and confirms the task is done. Any provider with a saved key works, including a smaller model on the
          same provider, which on free tiers also means a second quota.
        </p>
      </div>

      {/* Agent Section */}
      <div className="section">
        <label className="section-label">Agent</label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={trustedInput}
            onChange={(e) => handleTrustedInputChange(e.target.checked)}
          />
          <span>Real mouse &amp; keyboard input</span>
        </label>
        <p className="hint">
          Recommended: many sites ignore script-generated clicks and typing. While the agent works, Chrome shows a
          "started debugging this browser" banner; that's this feature, and it goes away when the agent finishes.
        </p>
        <label className="toggle-row" htmlFor="checkpoint">
          <span>Check in with me every</span>
          <select
            id="checkpoint"
            className="api-input"
            style={{ width: 'auto', marginLeft: 'auto' }}
            value={stepCheckpoint}
            onChange={(e) => handleCheckpointChange(Number(e.target.value))}
          >
            {CHECKPOINT_CHOICES.map((n) => (
              <option key={n} value={n}>{n ? `${n} steps` : 'Never'}</option>
            ))}
          </select>
        </label>
        <p className="hint">
          Tasks have no step limit. The agent pauses at this point to ask whether to keep going, so a long run doesn't
          quietly use up your API quota. It also pauses if it keeps repeating an action that changes nothing.
        </p>

        <label className="toggle-row" htmlFor="screenshots">
          <span>Screenshots for vision models</span>
          <select
            id="screenshots"
            className="api-input"
            style={{ width: 'auto', marginLeft: 'auto' }}
            value={screenshots}
            onChange={(e) => handleScreenshotsChange(e.target.value as ScreenshotMode)}
          >
            <option value="off">Off</option>
            <option value="planning">When planning</option>
            <option value="always">Every step</option>
          </select>
        </label>
        <p className="hint">
          Lets a model that can read images see the page, with each element's number drawn on it: useful for visual
          layouts, canvases and popups the page text doesn't describe.
        </p>
        {screenshots !== 'off' && (
          <p className="hint advisory">
            ⚠️ Screenshots use more tokens: each one adds roughly 500–1,500 to a step, depending on the model (about 1,300
            on Groq's Qwen), which can be as much again as the page text. {screenshots === 'always'
              ? 'On every step that adds up quickly, and on free tiers with per-minute limits (Groq: about 8k tokens/minute) the agent will be slower.'
              : '"When planning" sends one only on the first step, after something goes wrong, and every 5th step, which keeps most of the benefit for much less.'}
            {' '}Models that can't read images get text only, and the step log says so.
          </p>
        )}

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={nativeTools}
            onChange={(e) => handleNativeToolsChange(e.target.checked)}
          />
          <span>Native tool calling (experimental)</span>
        </label>
        <p className="hint">
          The model answers through the provider's function-calling feature instead of writing JSON, which some models
          get wrong. Models that don't support it fall back to JSON by themselves.
        </p>

        <label className="toggle-row" htmlFor="max-parallel">
          <span>Tasks at once</span>
          <select
            id="max-parallel"
            className="api-input"
            style={{ width: 'auto', marginLeft: 'auto' }}
            value={maxParallel}
            onChange={(e) => handleMaxParallelChange(Number(e.target.value))}
          >
            {PARALLEL_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <p className="hint">
          How many tasks may use the model at the same time, in different tabs (the "Run in background" button starts one
          without leaving your page). More wait in line: each running task sends requests, and free tiers limit requests
          per minute. Workflow replays don't count, since they don't use the model.
        </p>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={customCode}
            onChange={(e) => handleCustomCodeChange(e.target.checked)}
          />
          <span>Let the agent run its own code (advanced)</span>
        </label>
        <p className="hint">
          For data the built-in extract can't reach, the model may write a short script that reads the page. It runs
          separately from the page's own scripts, for 10 seconds at most, through the debugger connection (Chrome shows
          its banner).
        </p>
        {customCode && (
          <p className="hint advisory">
            ⚠️ The model writes this code, and a page it reads could try to trick it. Genesis refuses code that fetches,
            loads resources, reads cookies or storage, clicks or changes the page, and removes the network functions
            before running it. That lowers the risk but can't remove it. Turn this on only when you need it, not while
            the agent works on sites you're signed in to with sensitive data.
          </p>
        )}
      </div>

      {/* Skills Section */}
      <div className="section">
        <label className="section-label">Skills</label>
        <p className="hint">
          Saved instructions for tasks you repeat. The agent uses a skill when it fits the site and the task. After a task
          finishes, the sidebar offers "Save as skill".
        </p>
        {skills.length > 0 ? (
          <ul className="skill-list">
            {skills.map((s) => (
              <li key={s.name}>
                <div className="skill-head">
                  <strong>{s.name}</strong>
                  {s.sites.length > 0 && <span className="skill-sites">{s.sites.join(', ')}</span>}
                  <span className="skill-actions">
                    <button className="link-btn" onClick={() => setSkillDraft(formatSkill(s))}>Edit</button>
                    <button className="link-btn" onClick={() => handleDeleteSkill(s.name)}>Delete</button>
                  </span>
                </div>
                <div className="skill-desc">{s.description}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No skills yet.</p>
        )}
        <textarea
          className="api-input skill-editor"
          rows={skillDraft ? 8 : 2}
          placeholder={'Paste a SKILL.md to add it:\n---\nname: ...\ndescription: ...\n---\nSteps...'}
          value={skillDraft}
          onChange={(e) => setSkillDraft(e.target.value)}
        />
        {skillDraft.trim() && (
          <div className="input-group">
            <button onClick={handleSaveSkill} className="profile-save-btn">Save skill</button>
            <button onClick={() => { setSkillDraft(''); setSkillMessage(null); }} className="secondary-btn">Cancel</button>
          </div>
        )}
        {skillMessage && <div className={`message ${skillMessage.ok ? 'saved' : 'error'}`}>{skillMessage.text}</div>}
        {skillDraft.trim() && (
          <p className="hint advisory">
            ⚠️ The agent follows a skill's instructions, so only add skills you wrote or trust.
          </p>
        )}
      </div>

      {/* Workflows Section */}
      <div className="section">
        <label className="section-label">Workflows</label>
        <p className="hint">
          A task's exact steps, replayed with no model calls: instant and free. If the site has changed, the agent takes
          over from where the steps stopped fitting. Save one from the sidebar after a task finishes; run it here or by
          typing /name in the sidebar.
        </p>
        {workflows.length > 0 ? (
          <ul className="skill-list">
            {workflows.map((w) => (
              <li key={w.name}>
                <div className="skill-head">
                  <strong>{w.name}</strong>
                  <span className="skill-sites">{w.steps.length} steps{w.hasPassword ? ' · 🔒 password' : ''}</span>
                  <span className="skill-actions">
                    <button className="link-btn" onClick={() => handleRunWorkflow(w.name)}>Run</button>
                    <button className="link-btn" onClick={() => handleDeleteWorkflow(w.name)}>Delete</button>
                  </span>
                </div>
                <div className="skill-desc">{w.goal}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No workflows yet.</p>
        )}
        {workflowMessage && <div className={`message ${workflowMessage.ok ? 'saved' : 'error'}`}>{workflowMessage.text}</div>}
      </div>

      {/* Shortcuts Section */}
      <div className="section">
        <label className="section-label">Shortcuts</label>
        <p className="hint">
          Saved prompts: type /name in the sidebar to run one. Write a part that changes as a blank in braces, e.g.
          "Find the price of {'{product}'} on this site", then type /name running shoes.
        </p>
        {shortcuts.length > 0 && (
          <ul className="skill-list">
            {shortcuts.map((s) => (
              <li key={s.name}>
                <div className="skill-head">
                  <strong>/{s.name}</strong>
                  <span className="skill-actions">
                    <button className="link-btn" onClick={() => setShortcutDraft({ name: s.name, prompt: s.prompt, original: s.name })}>Edit</button>
                    <button className="link-btn" onClick={() => handleDeleteShortcut(s.name)}>Delete</button>
                  </span>
                </div>
                <div className="skill-desc">{s.prompt}</div>
              </li>
            ))}
          </ul>
        )}
        <input
          className="api-input"
          style={{ marginTop: 8 }}
          placeholder="Name (optional), e.g. price-check"
          value={shortcutDraft.name}
          onChange={(e) => setShortcutDraft((d) => ({ ...d, name: e.target.value }))}
          aria-label="Shortcut name"
        />
        <textarea
          className="api-input skill-editor"
          rows={2}
          placeholder="Prompt, e.g. Find the price of {product} on this site"
          value={shortcutDraft.prompt}
          onChange={(e) => setShortcutDraft((d) => ({ ...d, prompt: e.target.value }))}
          aria-label="Shortcut prompt"
        />
        {shortcutDraft.prompt.trim() && (
          <button onClick={handleSaveShortcut} className="profile-save-btn">Save shortcut</button>
        )}
        {shortcutMessage && <div className={`message ${shortcutMessage.ok ? 'saved' : 'error'}`}>{shortcutMessage.text}</div>}
      </div>

      {/* Schedules Section */}
      <div className="section">
        <label className="section-label">Schedules</label>
        <p className="hint">
          Run a workflow or shortcut automatically, in a background tab. You get a notification with the result; the tab
          closes if it worked and stays open if it didn't.
        </p>
        {schedules.length > 0 && (
          <ul className="skill-list">
            {schedules.map((s) => (
              <li key={s.id}>
                <div className="skill-head">
                  <input type="checkbox" checked={s.enabled} onChange={(e) => handleToggleSchedule(s.id, e.target.checked)} aria-label="On" />
                  <strong>/{s.name}</strong>
                  <span className="skill-sites">{describeFrequency(s)}</span>
                  <span className="skill-actions">
                    <button className="link-btn" onClick={() => handleRunScheduleNow(s.id)}>Run now</button>
                    <button className="link-btn" onClick={() => handleDeleteSchedule(s.id)}>Delete</button>
                  </span>
                </div>
                <div className="skill-desc">
                  {s.enabled && s.nextRun ? `Next: ${new Date(s.nextRun).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Off'}
                  {s.lastRun && ` · Last: ${s.lastRun.status === 'done' ? '✅' : '⚠️'} ${new Date(s.lastRun.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: ${s.lastRun.summary}`}
                </div>
              </li>
            ))}
          </ul>
        )}
        {workflows.length + shortcuts.length === 0 ? (
          <p className="hint">Save a workflow or shortcut first; then it can be scheduled here.</p>
        ) : (
          <>
            <select
              className="api-input"
              style={{ marginTop: 8 }}
              value={scheduleDraft.target}
              onChange={(e) => setScheduleDraft((d) => ({ ...d, target: e.target.value }))}
              aria-label="What to run"
            >
              <option value="">What to run…</option>
              {workflows.map((w) => <option key={`w:${w.name}`} value={`workflow:${w.name}`}>🔁 /{w.name} (workflow, no model)</option>)}
              {shortcuts.map((sc) => <option key={`s:${sc.name}`} value={`shortcut:${sc.name}`}>⚡ /{sc.name} (shortcut, uses your model)</option>)}
            </select>
            {scheduleDraft.target.startsWith('shortcut:') && (
              <>
                <input
                  className="api-input"
                  style={{ marginTop: 6 }}
                  placeholder="Page to start on, e.g. https://example.com"
                  value={scheduleDraft.url}
                  onChange={(e) => setScheduleDraft((d) => ({ ...d, url: e.target.value }))}
                  aria-label="Start page"
                />
                {draftBlanks.length > 0 && (
                  <input
                    className="api-input"
                    style={{ marginTop: 6 }}
                    placeholder={`Words for ${draftBlanks.map((b) => `{${b}}`).join(', ')}${draftBlanks.length > 1 ? ' (comma-separated)' : ''}`}
                    value={scheduleDraft.args}
                    onChange={(e) => setScheduleDraft((d) => ({ ...d, args: e.target.value }))}
                    aria-label="Words for the blanks"
                  />
                )}
              </>
            )}
            <div className="input-group" style={{ marginTop: 6 }}>
              <select
                className="api-input"
                value={scheduleDraft.frequency}
                onChange={(e) => setScheduleDraft((d) => ({ ...d, frequency: e.target.value as Frequency }))}
                aria-label="How often"
              >
                <option value="hourly">Every hour</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </select>
              {scheduleDraft.frequency === 'weekly' && (
                <select
                  className="api-input"
                  value={scheduleDraft.weekday}
                  onChange={(e) => setScheduleDraft((d) => ({ ...d, weekday: Number(e.target.value) }))}
                  aria-label="Day"
                >
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => <option key={day} value={i}>{day}</option>)}
                </select>
              )}
              <input
                type="time"
                className="api-input"
                value={scheduleDraft.time}
                onChange={(e) => setScheduleDraft((d) => ({ ...d, time: e.target.value }))}
                aria-label="Time"
              />
            </div>
            {scheduleDraft.target && <button onClick={handleSaveSchedule} className="profile-save-btn">Add schedule</button>}
            {scheduleMessage && <div className={`message ${scheduleMessage.ok ? 'saved' : 'error'}`}>{scheduleMessage.text}</div>}
            <p className="hint">
              Chrome has to be running at the time; if it was closed or asleep, a missed run happens once when it starts
              again. A scheduled shortcut uses your model's quota every time it runs; a workflow doesn't.
            </p>
          </>
        )}
      </div>

      {/* AI apps (MCP) Section */}
      <div className="section">
        <label className="section-label">AI apps (MCP)</label>
        <label className="toggle-row">
          <input type="checkbox" checked={mcp.enabled} onChange={(e) => saveMcp({ enabled: e.target.checked })} />
          <span>Let AI apps control this browser</span>
        </label>
        <p className="hint">
          Claude Code, Claude Desktop, Codex or any MCP app on this computer can then read pages and click, type and
          navigate through Genesis. The model runs in that app, on your plan with it; Genesis doesn't need its own key.
        </p>
        <div className="input-group">
          <input
            type="password"
            placeholder={mcp.hasToken ? 'Pairing token saved. Paste a new one to replace it' : 'Paste the pairing token'}
            value={mcpToken}
            onChange={(e) => setMcpToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && mcpToken.trim() && saveMcp({ token: mcpToken })}
            className="api-input"
            aria-label="Pairing token"
          />
          <button onClick={() => saveMcp({ token: mcpToken })} className="secondary-btn" disabled={!mcpToken.trim()}>Save</button>
        </div>
        <div className={`message ${mcp.status === 'connected' ? 'saved' : mcp.status === 'rejected' || mcpError ? 'error' : 'idle'}`}>
          {mcpError || MCP_STATUS_TEXT[mcp.status] + (mcp.detail ? `: ${mcp.detail}` : '')}
        </div>
        <p className="hint">
          Setup, once: build the helper (<code>cd mcp &amp;&amp; npm install &amp;&amp; npm run build</code>), run{' '}
          <code>node mcp/dist/server.js token</code> for the pairing token and the command that adds Genesis to your AI
          app, then paste the token here.
        </p>
        {mcp.enabled && (
          <p className="hint advisory">
            ⚠️ While this is on, a connected AI app can read and act on any page in this browser, including sites you're
            signed in to. Only connect apps you trust, and turn this off when you're not using it. The toolbar icon shows
            "MCP" while one is connected.
          </p>
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
