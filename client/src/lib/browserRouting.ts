import { useCallback, useEffect, useRef } from 'react';
import { useBlocker, useLocation, useNavigate, useNavigationType, type BlockerFunction } from 'react-router-dom';
import { BROWSER_EDITION } from './edition';

/**
 * In-memory routing for the browser edition: the Artifact frame's URL cannot
 * carry routes, so the current path is kept in sessionStorage across reloads
 * and `#/path` hashes (set by automated tests) are accepted as navigation.
 */
const LAST_PATH_KEY = 'sg:lastPath';
const HASH_ROUTE = /^#\/[\w\-/]*$/;
const SAFE_PATH = /^\/(?!\/)[\w\-/]*(\?[\w\-.~%=&+,:]*)?$/;

/** In-app entries behind the current one (browser edition), so "back" never lands outside the in-memory history. */
let historyDepth = 0;

const isSafeAppPath = (p: unknown): p is string => typeof p === 'string' && p.length <= 512 && SAFE_PATH.test(p);

/** Drop a consumed `#/path` so a later identical hash still fires and a reload resumes the last in-app path. */
function clearRouteHash() {
  try {
    history.replaceState(history.state, '', window.location.pathname + window.location.search);
  } catch {
    /* not permitted in this frame — the hash simply stays */
  }
}

/** Where the in-memory router starts: a `#/path` hash, else the last path this tab visited, else '/'. */
export function initialBrowserEntry(): string {
  try {
    const hash = window.location.hash;
    if (HASH_ROUTE.test(hash)) {
      clearRouteHash();
      return hash.slice(1);
    }
  } catch {
    /* ignore */
  }
  try {
    const last = sessionStorage.getItem(LAST_PATH_KEY);
    if (isSafeAppPath(last)) return last;
  } catch {
    /* storage unavailable */
  }
  return '/';
}

/** Forget the remembered path so the next page load starts at '/' (and so at sign-in when signed out). */
export function clearLastPath() {
  try {
    sessionStorage.removeItem(LAST_PATH_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Keeps sessionStorage in step with the in-memory location and follows `#/path` hash changes. */
export function BrowserRouteSync(): null {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const initial = useRef(true);
  const path = location.pathname + location.search;

  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    if (navigationType === 'PUSH') historyDepth += 1;
    else if (navigationType === 'POP') historyDepth = Math.max(0, historyDepth - 1);
  }, [location.key, navigationType]);

  useEffect(() => {
    if (!isSafeAppPath(path)) return;
    try {
      sessionStorage.setItem(LAST_PATH_KEY, path);
    } catch {
      /* storage unavailable */
    }
  }, [path]);

  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      if (!HASH_ROUTE.test(hash)) return;
      clearRouteHash();
      navigate(hash.slice(1));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [navigate]);

  return null;
}

/** Go back one entry; in the browser edition, go to `fallback` when there is no earlier in-app entry (e.g. after a reload). */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  return () => {
    if (BROWSER_EDITION && historyDepth === 0) navigate(fallback);
    else navigate(-1);
  };
}

/**
 * Unsaved-changes guard for a page. While `dirty`, in-app navigation to another page (links, notifications,
 * `#/path`, `__sgNavigate`, sign-out, Back) is held until the page answers its own confirmation: render it
 * while `blocked`, then call `stay()` or `leave()`. In the standard edition reloading or closing the tab also
 * raises the browser's prompt; the browser edition's frame suppresses native dialogs, so it is not used there.
 * Needs the data router set up in main.tsx; a router holds one guard at a time.
 */
export function useUnsavedChangesGuard(dirty: boolean): { blocked: boolean; stay: () => void; leave: () => void } {
  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname, [dirty]);
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (!dirty || BROWSER_EDITION) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older browsers only prompt when this is set
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return {
    blocked: blocker.state === 'blocked',
    stay: () => blocker.state === 'blocked' && blocker.reset(),
    leave: () => blocker.state === 'blocked' && blocker.proceed(),
  };
}
