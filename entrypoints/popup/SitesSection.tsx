// entrypoints/popup/SitesSection.tsx
// The user's site lists (lib/agent/sites.ts): sites the agent never acts on,
// and optionally the only sites it may act on without asking.
import { useEffect, useState } from 'react';
import { normalizeSite, type SiteRules } from '@/lib/agent/sites';

type ListName = keyof SiteRules;

export default function SitesSection() {
  const [rules, setRules] = useState<SiteRules>({ blocked: [], allowed: [] });
  const [drafts, setDrafts] = useState<Record<ListName, string>>({ blocked: '', allowed: '' });
  const [error, setError] = useState<string | null>(null);
  /** The site of the tab the popup was opened on, for one-click blocking. */
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    browser.runtime.sendMessage({ action: 'GET_SITES' }).then((res: any) => { if (res?.success) setRules(res.data); }).catch(() => {});
    browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => setCurrent(/^https?:/.test(tab?.url ?? '') ? normalizeSite(tab!.url!) : null))
      .catch(() => {});
  }, []);

  const save = async (list: ListName, change: { add?: string; remove?: string }) => {
    setError(null);
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_SITES', payload: { list, ...change } }).catch((err: Error) => ({ error: err.message }));
    if (!res?.success) {
      setError(res?.error || 'Could not save');
      return false;
    }
    setRules(res.data);
    return true;
  };

  const add = async (list: ListName) => {
    if (await save(list, { add: drafts[list] })) setDrafts({ ...drafts, [list]: '' });
  };

  const listView = (list: ListName, empty: string) => (
    rules[list].length > 0 ? (
      <ul className="skill-list">
        {rules[list].map((site) => (
          <li key={site}>
            <div className="skill-head">
              <span>{site}</span>
              <span className="skill-actions">
                <button className="link-btn" onClick={() => save(list, { remove: site })}>Remove</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    ) : <p className="hint">{empty}</p>
  );

  const addRow = (list: ListName, placeholder: string) => (
    <div className="input-group">
      <input
        className="api-input"
        placeholder={placeholder}
        value={drafts[list]}
        onChange={(e) => setDrafts({ ...drafts, [list]: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter' && drafts[list].trim()) add(list); }}
      />
      <button className="secondary-btn" disabled={!drafts[list].trim()} onClick={() => add(list)}>Add</button>
    </div>
  );

  const blockedHere = current && rules.blocked.includes(current);

  return (
    <div className="section">
      <label className="section-label">Sites</label>
      <p className="hint">
        Your own rules for where the agent may act. They're checked by Tabi itself, not by a model, so no page can talk
        its way past them. They apply to every task, schedule and workflow, and to AI apps connected through MCP.
      </p>

      <strong className="hint">Never act on</strong>
      <p className="hint">
        The agent won't open, read or act on these sites or their subdomains (e.g. your bank, work email, cloud console).
        If a task lands on one, it stops.
      </p>
      {current && !blockedHere && (
        <button className="secondary-btn" style={{ alignSelf: 'flex-start', padding: '6px 10px' }} onClick={() => save('blocked', { add: current })}>
          Block {current}
        </button>
      )}
      {listView('blocked', 'No blocked sites.')}
      {addRow('blocked', 'mybank.com')}

      <strong className="hint">Only act on (optional)</strong>
      <p className="hint">
        Leave empty to let the agent go anywhere not blocked. Once you add sites, it asks you before using any other one,
        and trusts these enough to skip the safety check on them.
      </p>
      {listView('allowed', 'Empty: any site that isn\'t blocked.')}
      {addRow('allowed', 'shop.example.com')}
      {error && <div className="message error">{error}</div>}
    </div>
  );
}
