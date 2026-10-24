import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * In-memory routing for the browser edition: the Artifact frame's URL cannot
 * carry routes, so the current path is kept in sessionStorage across reloads
 * and `#/path` hashes (set by automated tests) are accepted as navigation.
 */
const LAST_PATH_KEY = 'sg:lastPath';
const HASH_ROUTE = /^#\/[\w\-/]*$/;
const SAFE_PATH = /^\/(?!\/)[\w\-/]*(\?[\w\-.~%=&+,:]*)?$/;

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
  const path = location.pathname + location.search;

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
