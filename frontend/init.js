import mailcheckApp from './mailcheckApp.js';

window.mailcheckApp = mailcheckApp;

// Register with Alpine when ready
if (window.Alpine && typeof window.Alpine.data === 'function') {
  window.Alpine.data('mailcheckApp', mailcheckApp);
} else {
  document.addEventListener('alpine:init', () => {
    try {
      if (window.Alpine && typeof window.Alpine.data === 'function') {
        window.Alpine.data('mailcheckApp', mailcheckApp);
      }
    } catch (_) { /* no-op */ }
  });
}

// If Alpine was deferred via window.deferLoadingAlpine, start it now
try { if (typeof window._startAlpine === 'function') window._startAlpine(); } catch (_) {}


