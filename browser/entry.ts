/**
 * Browser edition entry point. The client renders into #root straight away
 * (its API requests wait for the in-page server); a start-up overlay covers
 * it until the server has booted.
 */
import './early.js';
import './splash.css';
import { bootBrowserBackend, type BootStep } from './backend/host.js';
import '../client/src/main.tsx';

const STEPS: { key: BootStep; label: string }[] = [
  { key: 'engine', label: 'Loading the database engine' },
  { key: 'restore', label: 'Opening saved demo data on this device' },
  { key: 'seed', label: 'Generating the synthetic demo dataset' },
  { key: 'start', label: 'Starting SecureGate' },
];

const overlay = document.createElement('div');
overlay.className = 'sg-splash-overlay';
document.body.append(overlay);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function renderSplash() {
  const wrap = el('div', 'sg-splash');
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  const card = el('div', 'sg-splash-card');
  const mark = el('div', 'sg-splash-mark');
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 2.8 4.5 5.6v6.1c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V5.6z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m8.8 12 2.2 2.2 4.3-4.4"/></svg>';
  const title = el('h1', 'sg-splash-title', 'TCP SecureGate');
  const sub = el('p', 'sg-splash-sub', 'Browser edition · synthetic demonstration data');
  const list = el('ol', 'sg-splash-steps');
  for (const s of STEPS) {
    const li = el('li', 'sg-step', s.label);
    li.dataset.step = s.key;
    list.append(li);
  }
  const note = el('p', 'sg-splash-note', 'Everything runs inside this page. No data is sent anywhere.');
  card.append(mark, title, sub, list, note);
  wrap.append(card);
  overlay.replaceChildren(wrap);
  return list;
}

function markStep(list: HTMLElement, step: BootStep) {
  const keys = STEPS.map((s) => s.key);
  const idx = keys.indexOf(step);
  list.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
    const i = keys.indexOf(li.dataset.step as BootStep);
    li.classList.toggle('is-done', i < idx);
    li.classList.toggle('is-active', i === idx);
  });
}

function renderFailure(err: unknown) {
  const wrap = el('div', 'sg-splash');
  const card = el('div', 'sg-splash-card');
  const title = el('h1', 'sg-splash-title', 'SecureGate could not start');
  const msg = el('p', 'sg-splash-sub', err instanceof Error ? err.message : 'An unexpected error occurred while starting the browser edition.');
  const btn = el('button', 'sg-splash-btn', 'Erase saved demo data and retry');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      indexedDB.deleteDatabase('tcp-securegate-browser-edition');
    } catch {
      /* ignore */
    }
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    window.location.reload();
  });
  card.append(title, msg, btn);
  wrap.append(card);
  overlay.replaceChildren(wrap);
}

async function start() {
  const list = renderSplash();
  try {
    await bootBrowserBackend((step) => markStep(list, step));
  } catch (err) {
    console.error('[securegate] browser edition failed to start', err);
    renderFailure(err);
    return;
  }
  overlay.classList.add('is-leaving');
  setTimeout(() => overlay.remove(), 250);
}

void start();
