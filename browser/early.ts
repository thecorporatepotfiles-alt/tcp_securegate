// Imported before anything else: from this point every `/api` fetch is routed
// to the in-page server (and waits for it to finish starting).
import { interceptApiRequests } from './backend/host.js';

interceptApiRequests();
