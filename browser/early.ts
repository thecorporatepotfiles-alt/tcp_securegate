// Imported before anything else: from this point every `/api` fetch is routed
// to the in-page server (and waits for it to finish starting).
import { interceptApiRequests } from './backend/host.js';

// The Artifact wrapper's <html> element carries no lang; screen readers need one.
if (!document.documentElement.lang) document.documentElement.lang = 'en';

interceptApiRequests();
