export default function mailcheckApp() {
  const inst = {
    // Groq key UI (kept for future LLM-based checks)
    hasServerKey: true,
    userApiKey: '',
    apiKeyInput: '',

    // Jobs
    jobName: '',
    jobInput: '',
    jobStore: {}, // { [jobName]: { items: Record<string, any>[], meta: {...}, updated_at } }
    jobsArray: [],

    // Ingest/UI state
    systemPrompt: '',
    pasteInput: '',
    sourceFileName: '',
    sourceKind: '', // 'csv' | 'json' | 'text'
    sourceHeaders: [], // headers from CSV/JSON when applicable
    items: [], // array of row objects, each includes detected email and bg fields
    emailFieldName: '',
    detectedEmailCount: 0,

    // Whitelist/Blacklist rules UI (emails or domains or regex), persisted in localStorage
    whitelistText: '',
    blacklistText: '',

    // Single email spot-check
    singleEmailInput: '',
    singleChecking: false,
    singleResult: null,

    // Run state
    isRunning: false,
    cancelRequested: false,
    concurrency: 8,

    // Background job runners keyed by job name. Each runner manages its own queue/state.
    jobRunners: {},
    // Interval used to reflect active job runner state in the UI
    _activeRunnerInterval: null,
    // Map of jobName -> boolean running flag for sidebar indicators
    jobRunningMap: {},
    // Map of jobName -> last completion timestamp for "done" flash
    jobDoneAt: {},
    // Duration to show the done flash (ms)
    jobDoneFlashMs: 3500,

    // Sidebar/UI
    sidebarOpen: false,
    sidebarCollapsed: false,
    sidebarTransitioning: false,
    sidebarAnimMs: 300,

    async init() {
      // API key from localStorage
      try {
        const storedApiKey = localStorage.getItem('groq_api_key');
        if (storedApiKey) this.userApiKey = storedApiKey;
      } catch (_) {}
      await this.checkServerKey();

      // Load job name + jobs
      try {
        const storedJob = localStorage.getItem('mailcheck_job_name');
        if (storedJob) { this.jobName = storedJob; this.jobInput = storedJob; }
      } catch (_) {}
      try { this.loadJobsFromStorage(); this.refreshJobsArray(); } catch (_) {}
      // If active job exists, hydrate
      if (this.jobName && this.jobStore[this.jobName]) {
        this.hydrateFromJob(this.jobStore[this.jobName]);
      }
      // Load whitelist/blacklist from storage with UI-provided examples
      try {
        const wl = localStorage.getItem('mailcheck_whitelist_v1');
        this.whitelistText = (wl && wl.trim()) ? wl : '@groq.com';
      } catch (_) { this.whitelistText = '@groq.com'; }
      try {
        const bl = localStorage.getItem('mailcheck_blacklist_v1');
        this.blacklistText = (bl && bl.trim()) ? bl : '/^[a-z]{2,}[0-9]{1,4}@/i\n@temp-mail.com\n*@noidem';
      } catch (_) { this.blacklistText = '/^[a-z]{2,}[0-9]{1,4}@/i\n@temp-mail.com\n*@noidem'; }
      try { this._refreshJobRunningMap(); } catch (_) {}
      try { this._watchActiveRunner(); } catch (_) {}
    },

    async checkServerKey() {
      try {
        const r = await fetch('/api/check-key');
        const j = await r.json();
        this.hasServerKey = !!j.hasServerKey;
      } catch (_) { this.hasServerKey = false; }
    },

    setApiKey() {
      if (this.apiKeyInput && this.apiKeyInput.trim()) {
        this.userApiKey = this.apiKeyInput.trim();
        try { localStorage.setItem('groq_api_key', this.userApiKey); } catch (_) {}
        this.apiKeyInput = '';
      }
    },
    changeApiKey() { this.userApiKey = ''; },
    clearApiKey() { this.userApiKey = ''; try { localStorage.removeItem('groq_api_key'); } catch (_) {} },
    get maskedApiKey() {
      if (!this.userApiKey) return '';
      const k = this.userApiKey;
      return k.substring(0, 8) + '*'.repeat(Math.max(0, k.length - 12)) + k.substring(k.length - 4);
    },

    // Jobs
    loadJobsFromStorage() {
      try {
        const raw = localStorage.getItem('mailcheck_jobs_v1');
        this.jobStore = raw ? JSON.parse(raw) : {};
      } catch (_) { this.jobStore = {}; }
    },
    saveJobsToStorage() {
      try { localStorage.setItem('mailcheck_jobs_v1', JSON.stringify(this.jobStore)); } catch (_) {}
      this.refreshJobsArray();
    },
    saveActiveJob() {
      try {
        const name = (this.jobName || '').trim();
        if (!name) return;
        const existed = this.jobStore ? this.jobStore[name] : null;
        const payload = {
          job: name,
          items: Array.isArray(this.items) ? this.items : [],
          meta: {
            systemPrompt: this.systemPrompt || '',
            sourceKind: this.sourceKind || '',
            sourceHeaders: Array.isArray(this.sourceHeaders) ? this.sourceHeaders : [],
            emailFieldName: this.emailFieldName || '',
            sourceFileName: this.sourceFileName || ''
          },
          created_at: existed && existed.created_at ? existed.created_at : new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        this.jobStore[name] = payload;
        this.saveJobsToStorage();
        // Persist lists for the app
        try { localStorage.setItem('mailcheck_whitelist_v1', this.whitelistText || ''); } catch (_) {}
        try { localStorage.setItem('mailcheck_blacklist_v1', this.blacklistText || ''); } catch (_) {}
      } catch (_) {}
    },
    hydrateFromJob(jobPayload) {
      try {
        const p = jobPayload || {};
        this.items = Array.isArray(p.items) ? p.items : [];
        const m = p.meta || {};
        this.systemPrompt = m.systemPrompt || '';
        this.sourceKind = m.sourceKind || '';
        this.sourceHeaders = Array.isArray(m.sourceHeaders) ? m.sourceHeaders : [];
        this.emailFieldName = m.emailFieldName || '';
        this.sourceFileName = m.sourceFileName || '';
        // recompute detected count
        this.detectedEmailCount = (this.items || []).reduce((acc, it) => acc + (this.getRecordEmail(it) ? 1 : 0), 0);
      } catch (_) {}
    },
    refreshJobsArray() {
      try {
        const arr = Object.entries(this.jobStore || {}).map(([name, payload]) => {
          const items = Array.isArray(payload?.items) ? payload.items : [];
          const done = items.filter((it) => !!(it && (it.bg_status === 'person_high' || it.bg_status === 'person_low' || it.bg_status === 'person_none' || it.bg_status === 'spam' || it.bg_status === 'error'))).length;
          return { name, answersCount: done, created_at: payload?.created_at || payload?.updated_at || null };
        });
        arr.sort((a, b) => {
          const ta = a.created_at ? Date.parse(a.created_at) : 0;
          const tb = b.created_at ? Date.parse(b.created_at) : 0;
          if (ta !== tb) return ta - tb; // stable by creation time
          return a.name.localeCompare(b.name);
        });
        this.jobsArray = arr;
      } catch (_) { this.jobsArray = []; }
    },
    nextDefaultJobName() {
      try {
        const keys = Object.keys(this.jobStore || {});
        let maxN = 0;
        for (const k of keys) {
          const m = /^job-(\d+)$/.exec(k);
          if (m) {
            const n = parseInt(m[1], 10);
            if (!Number.isNaN(n) && n > maxN) maxN = n;
          }
        }
        return `job-${maxN + 1}`;
      } catch (_) {
        return 'job-1';
      }
    },
    setJobName() {
      const newName = (this.jobInput || '').trim();
      const oldName = this.jobName || '';
      if (!newName) return;
      if (oldName && newName !== oldName) {
        try {
          const existed = this.jobStore && this.jobStore[oldName];
          if (existed) {
            const migrated = { ...existed, job: newName, updated_at: new Date().toISOString() };
            this.jobStore[newName] = migrated;
            try { delete this.jobStore[oldName]; } catch (_) {}
            this.saveJobsToStorage();
          }
        } catch (_) {}
      }
      this.jobName = newName;
      try { localStorage.setItem('mailcheck_job_name', this.jobName || ''); } catch (_) {}
      try { this.saveActiveJob(); } catch (_) {}
    },
    selectJob(name) {
      try { this.saveActiveJob(); } catch (_) {}
      const j = this.jobStore && this.jobStore[name];
      if (!j) return;
      this.jobName = name;
      this.jobInput = name;
      try { localStorage.setItem('mailcheck_job_name', name); } catch (_) {}
      this.hydrateFromJob(j);
      try { this.saveActiveJob(); } catch (_) {}
      // Reflect background runner state for the newly selected job
      try {
        const s = this.getBackgroundRunStatus(this.jobName);
        this.isRunning = !!(s && s.running);
        this._watchActiveRunner();
      } catch (_) {}
    },
    createNewJob() {
      try { this.saveActiveJob(); } catch (_) {}
      const defaultName = this.nextDefaultJobName();
      this.jobName = defaultName;
      this.jobInput = defaultName;
      this.items = [];
      this.sourceHeaders = [];
      this.sourceKind = '';
      this.emailFieldName = '';
      this.detectedEmailCount = 0;
      try { this.saveActiveJob(); } catch (_) {}
      try { localStorage.setItem('mailcheck_job_name', defaultName); } catch (_) {}
    },
    deleteJob(name) {
      try {
        if (!name) return;
        if (this.jobStore && this.jobStore[name]) {
          delete this.jobStore[name];
          this.saveJobsToStorage();
        }
        if (this.jobName === name) {
          this.jobName = '';
          this.jobInput = '';
          this.items = [];
          this.sourceHeaders = [];
          this.sourceKind = '';
          this.emailFieldName = '';
          this.detectedEmailCount = 0;
          try { localStorage.removeItem('mailcheck_job_name'); } catch (_) {}
        }
      } catch (_) {}
    },

    // Sidebar helpers
    toggleSidebar() { this.sidebarOpen = !this.sidebarOpen; },
    collapseSidebar() { this.sidebarTransitioning = true; this.sidebarCollapsed = true; setTimeout(() => { this.sidebarTransitioning = false; }, this.sidebarAnimMs); },
    expandSidebar() { this.sidebarTransitioning = true; this.sidebarCollapsed = false; setTimeout(() => { this.sidebarTransitioning = false; }, this.sidebarAnimMs); },

    // Mark job as done just now (for UI flash)
    markJobDone(name) { try { if (!name) return; this.jobDoneAt[name] = Date.now(); } catch (_) {} },
    // Whether job recently completed (and not currently running)
    isJobDoneRecently(name) {
      try {
        if (!name) return false;
        if (this.isJobRunning(name)) return false;
        const ts = this.jobDoneAt && this.jobDoneAt[name];
        if (!ts) return false;
        return (Date.now() - ts) < (this.jobDoneFlashMs || 3000);
      } catch (_) { return false; }
    },
    // Refresh running map and, if fully idle, mark as done
    finishCheckForJob(name) {
      try { this._refreshJobRunningMap(); if (!this._computeJobIsRunning(name)) this.markJobDone(name); } catch (_) {}
    },

    // --- Multi-job Background Runners ---
    // Start a background run for a specific job name. Creates an isolated runner that
    // continues even if the UI switches to another job. Safe for multiple jobs in parallel.
    startBackgroundRunForJob(jobName, options = {}) {
      try {
        const name = String(jobName || '').trim();
        if (!name) return null;
        if (this.jobRunners[name] && this.jobRunners[name].status().running) {
          return this.jobRunners[name];
        }
        const runner = createJobRunner(this, name, {
          concurrency: Math.max(1, Number(options.concurrency || this.concurrency) || 8),
          onlyPending: options.onlyPending !== false
        });
        this.jobRunners[name] = runner;
        runner.start();
        try { this.jobRunningMap[name] = true; this._refreshJobRunningMap(); this._watchActiveRunner(); } catch (_) {}
        return runner;
      } catch (_) { return null; }
    },

    // Cancel a background run for a job, if one is active.
    cancelBackgroundRunForJob(jobName) {
      try {
        const r = this.jobRunners && this.jobRunners[jobName];
        if (r) r.cancel();
        try { this.jobRunningMap[jobName] = false; this._refreshJobRunningMap(); } catch (_) {}
      } catch (_) {}
    },

    // Shallow status snapshot for a job's runner (or a default if none).
    getBackgroundRunStatus(jobName) {
      try {
        const r = this.jobRunners && this.jobRunners[jobName];
        return r ? r.status() : { running: false, cancelled: false, total: 0, completed: 0 };
      } catch (_) { return { running: false, cancelled: false, total: 0, completed: 0 }; }
    },
    // Public helper for templates
    isJobRunning(name) {
      try { return !!this.jobRunningMap && !!this.jobRunningMap[name]; } catch (_) { return false; }
    },
    // Refresh the running map for all known jobs
    _refreshJobRunningMap() {
      try {
        const names = new Set(Object.keys(this.jobStore || {}));
        for (const n of Object.keys(this.jobRunners || {})) names.add(n);
        const next = {};
        for (const n of names) next[n] = this._computeJobIsRunning(n);
        this.jobRunningMap = next;
      } catch (_) {}
    },

    // Compute if a job appears to be running by either active runner state or any 'checking' items
    _computeJobIsRunning(jobName) {
      try {
        if (!jobName) return false;
        const s = this.getBackgroundRunStatus(jobName);
        if (s && s.running) return true;
        const payload = this.jobStore && this.jobStore[jobName];
        if (!payload || !Array.isArray(payload.items)) return false;
        for (const it of payload.items) { if (it && it.bg_status === 'checking') return true; }
        return false;
      } catch (_) { return false; }
    },

    // Parsing & ingest
    async handleFileChange(evt) {
      try {
        const file = (evt && evt.target && evt.target.files && evt.target.files[0]) ? evt.target.files[0] : null;
        if (!file) return;
        this.sourceFileName = file.name || '';
        this.ensureDefaultJobName(file.name || '(upload)');
        const text = await file.text();
        await this.parseInputText(text, file.name || 'upload');
      } catch (_) {}
    },
    async parsePaste() {
      this.ensureDefaultJobName('(pasted)');
      await this.parseInputText(this.pasteInput || '', '(pasted)', { append: true });
      this.pasteInput = '';
    },
    looksLikeJson(text) {
      const t = String(text || '').trim();
      return t.startsWith('{') || t.startsWith('[');
    },
    async parseInputText(text, filename, options = {}) {
      try {
        const trimmed = String(text || '').trim();
        if (!trimmed) {
          if (!options.append) {
            this.items = []; this.sourceHeaders = []; this.sourceKind = ''; this.emailFieldName=''; this.detectedEmailCount=0; this.saveActiveJob();
          }
          return;
        }

        // Always extract emails, regardless of whether it looks like JSON/CSV
        this.sourceKind = 'text'; // Explicitly set sourceKind to text
        const emails = this.extractEmailsFromText(trimmed);
        const objs = emails.map((email) => ({ email }));
        await this.ingestObjectsArray(objs, { append: !!options.append });

        this.saveActiveJob();
      } catch (_) {}
    },

    // Ensure a default job name exists before saving parsed content
    ensureDefaultJobName(sourceLabel) {
      try {
        if ((this.jobName || '').trim()) return;
        let candidate = this.nextDefaultJobName();
        // Avoid duplicates (paranoia)
        let ctr = 2;
        while (this.jobStore && this.jobStore[candidate]) { candidate = `job-${parseInt(candidate.split('-')[1] || '1', 10) + 1}`; ctr++; }
        this.jobName = candidate;
        this.jobInput = candidate;
        try { localStorage.setItem('mailcheck_job_name', candidate); } catch (_) {}
        try { this.saveActiveJob(); } catch (_) {}
      } catch (_) {}
    },

    // Inline edit helpers
    enableEdit(idx) {
      try {
        const it = this.items[idx];
        if (!it) return;
        it._editingEmail = true;
        it._editEmailValue = this.getRecordEmail(it);
      } catch (_) {}
    },
    commitEdit(idx) {
      try {
        const it = this.items[idx];
        if (!it) return;
        const val = String(it._editEmailValue || '').trim();
        const key = (this.emailFieldName && (this.emailFieldName in it)) ? this.emailFieldName : 'email';
        it[key] = val;
        it.email = val;
        // reset status so it can be re-run
        it.bg_status = 'pending';
        it.bg_message = '';
        it.bg_checked_at = null;
        // end edit
        it._editingEmail = false;
        delete it._editEmailValue;
        this.recomputeDetectedEmails();
        this.saveActiveJob();
      } catch (_) {}
    },
    cancelEdit(idx) {
      try {
        const it = this.items[idx];
        if (!it) return;
        it._editingEmail = false;
        delete it._editEmailValue;
      } catch (_) {}
    },
    deleteItem(idx) {
      try {
        if (!confirm('Delete this row?')) return;
        if (idx < 0 || idx >= (this.items?.length || 0)) return;
        this.items.splice(idx, 1);
        this.recomputeDetectedEmails();
        this.saveActiveJob();
      } catch (_) {}
    },
    recomputeDetectedEmails() {
      try {
        this.detectedEmailCount = (this.items || []).reduce((acc, it) => acc + (this.getRecordEmail(it) ? 1 : 0), 0);
      } catch (_) { this.detectedEmailCount = 0; }
    },
    parseCsv(text) {
      // Minimal CSV parser supporting quotes and commas
      const rows = [];
      let row = [];
      let i = 0, inQuotes = false, field = '';
      const pushField = () => { row.push(field); field = ''; };
      const pushRow = () => { rows.push(row); row = []; };
      while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
          if (ch === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
          } else { field += ch; }
        } else {
          if (ch === '"') { inQuotes = true; }
          else if (ch === ',') { pushField(); }
          else if (ch === '\n') { pushField(); pushRow(); }
          else if (ch === '\r') { /* ignore */ }
          else { field += ch; }
        }
        i++;
      }
      // last field
      pushField();
      // last row if not added
      if (row.length > 0) pushRow();
      // Trim possible trailing empty row
      while (rows.length > 0 && rows[rows.length - 1].every(v => String(v || '').trim() === '')) rows.pop();
      // Determine headers: if first row has any non-email header-like strings, assume header row; else synthesize
      let headers = [];
      if (rows.length > 0) {
        const first = rows[0].map((s) => String(s || '').trim());
        const hasAlpha = first.some((s) => /[a-zA-Z]/.test(s));
        const looksHeaderish = hasAlpha && !first.every((s) => this.isEmail(s));
        if (looksHeaderish) {
          headers = first.map((h, idx) => h || ('col_' + (idx + 1)));
          rows.shift();
        } else {
          headers = first.map((_, idx) => 'col_' + (idx + 1));
        }
      }
      return { headers, rows };
    },
    async ingestCsvParsed(headers, rows, options = {}) {
      const normalizedHeaders = headers.map(h => String(h || '').trim());
      this.sourceHeaders = normalizedHeaders;
      // Build objects per row
      const items = rows.map((r) => {
        const obj = {};
        for (let i = 0; i < normalizedHeaders.length; i++) {
          const key = normalizedHeaders[i] || ('col_' + (i + 1));
          obj[key] = r[i] !== undefined ? r[i] : '';
        }
        return obj;
      });
      await this.ingestObjectsArray(items, { append: !!options.append });
    },
    async ingestObjectsArray(objs, options = {}) {
      const items = Array.isArray(objs) ? objs.map((o) => (o && typeof o === 'object') ? { ...o } : { value: String(o) }) : [];
      // Detect email field name if not already set
      if (!this.emailFieldName) this.emailFieldName = this.detectEmailFieldName(items);
      // Normalize each row with bg fields
      const newItems = items.map((it, idx) => {
        const email = this.extractEmailFromRecord(it);
        return {
          ...it,
          email: email || it.email || it.Email || it.e_mail || it.mail || '',
          _row_index: (this.items?.length || 0) + idx,
          bg_status: 'pending',
          bg_message: '',
          bg_checked_at: null
        };
      });
      if (options.append) {
        const existing = new Set((this.items || []).map((it) => this.emailKey(this.getRecordEmail(it))));
        const filtered = newItems.filter((it) => {
          const k = this.emailKey(this.getRecordEmail(it));
          if (!k) return false;
          if (existing.has(k)) return false;
          existing.add(k);
          return true;
        });
        this.items = [...(this.items || []), ...filtered];
      } else {
        this.items = newItems;
      }
      this.recomputeDetectedEmails();
    },
    emailKey(s) { return String(s || '').trim().toLowerCase(); },
    detectEmailFieldName(items) {
      // 1) Prefer property names that include 'email'
      const candidateNames = new Set();
      for (const it of (items || [])) {
        for (const k of Object.keys(it || {})) {
          const lower = k.toLowerCase();
          if (lower.includes('email')) candidateNames.add(k);
        }
      }
      if (candidateNames.size > 0) {
        // Choose the one with most valid-looking values
        let best = '', bestCount = -1;
        for (const k of candidateNames) {
          let count = 0;
          for (const it of (items || [])) { if (this.isEmail(String(it[k] || ''))) count++; }
          if (count > bestCount) { best = k; bestCount = count; }
        }
        if (best) return best;
      }
      // 2) Otherwise, scan all fields and pick the field with the most email-like values
      const counts = {};
      for (const it of (items || [])) {
        for (const [k, v] of Object.entries(it || {})) {
          if (this.isEmail(String(v || ''))) counts[k] = (counts[k] || 0) + 1;
        }
      }
      let maxK = '';
      let maxV = -1;
      for (const [k, v] of Object.entries(counts)) { if (v > maxV) { maxK = k; maxV = v; } }
      return maxV > 0 ? maxK : 'email';
    },
    isEmail(s) {
      const str = String(s || '').trim();
      if (!str) return false;
      // Simple, permissive email regex
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str);
    },
    extractEmailsFromText(text) {
      try {
        const src = String(text || '');
        const matches = src.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
        const seen = new Set();
        const out = [];
        for (let m of matches) {
          let e = String(m || '').trim();
          e = e.replace(/^[<({\["']+/, '');
          e = e.replace(/[>)}\]"',.;:!?]+$/, '');
          e = e.toLowerCase();
          if (this.isEmail(e)) {
            const k = this.emailKey(e);
            if (!seen.has(k)) { seen.add(k); out.push(e); }
          }
        }
        return out;
      } catch (_) { return []; }
    },
    extractEmailFromRecord(it) {
      if (!it || typeof it !== 'object') return '';
      // 1) Direct by detected field name
      if (this.emailFieldName && it[this.emailFieldName]) return String(it[this.emailFieldName] || '').trim();
      // 2) Common keys
      for (const k of ['email', 'Email', 'e_mail', 'mail']) { if (it[k]) return String(it[k]).trim(); }
      // 3) Search values for email-looking string
      for (const v of Object.values(it)) { if (this.isEmail(v)) return String(v).trim(); }
      return '';
    },
    getRecordEmail(it) {
      return this.extractEmailFromRecord(it);
    },

    // Run checks with per-row updates
    async runChecks() {
      if (!Array.isArray(this.items) || this.items.length === 0) return;
      // Kick off a background run for the active job (include all rows)
      this.cancelRequested = false;
      this.startBackgroundRunForJob(this.jobName, { concurrency: this.concurrency, onlyPending: false });
      this.isRunning = true;
      this._watchActiveRunner();
    },
    async runPendingChecks() {
      if (!Array.isArray(this.items) || this.items.length === 0) return;
      // Kick off a background run for the active job (pending only)
      this.cancelRequested = false;
      this.startBackgroundRunForJob(this.jobName, { concurrency: this.concurrency, onlyPending: true });
      this.isRunning = true;
      this._watchActiveRunner();
    },
    // Individual row run for active job delegates to generic per-job API
    async runOne(idx) { return await this.runOneForJob(this.jobName, idx); },
    // Run one record by job name and row index (works even if a background run is active)
    async runOneForJob(jobName, idx) {
      try {
        const payload = this.jobStore && this.jobStore[jobName];
        if (!payload) return;
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (idx < 0 || idx >= items.length) return;
        const rec = items[idx];
        if (!rec) return;
        if (rec.bg_status === 'checking') return; // already in flight
        const email = this.getRecordEmail ? this.getRecordEmail(rec) : (rec.email || '');
        // Clear previous per-check transient fields (fully reset assessment UI)
        delete rec.bg_compound_msg; delete rec.bg_compound_debug; delete rec.bg_browser_debug;
        delete rec.bg_compound_label; delete rec.bg_compound_short; delete rec.bg_compound_detail;
        delete rec.bg_browser_label; delete rec.bg_browser_short; delete rec.bg_browser_detail;
        delete rec.bg_final_label; delete rec.bg_final_short; delete rec.bg_final_detail;
        delete rec.bg_compound_evidence; delete rec.bg_browser_evidence; delete rec.bg_final_evidence;
        if (!email || !(this.isEmail && this.isEmail(email))) {
          rec.bg_status = 'error';
          rec.bg_message = 'No email detected';
          rec.bg_checked_at = new Date().toISOString();
          payload.items[idx] = rec; payload.updated_at = new Date().toISOString();
          this.jobStore[jobName] = payload; this.saveJobsToStorage(); this.refreshJobsArray();
          if (this.jobName === jobName) { this.items[idx] = { ...this.items[idx], ...rec }; this.recomputeDetectedEmails(); }
          return;
        }
          if (!this.hasServerKey && !this.userApiKey) throw new Error('No Groq API key set. Add a key to run checks.');
        // Mark as checking and persist before network call to avoid duplicate work by runners
        rec.bg_status = 'checking'; rec.bg_message = ''; rec.bg_checked_at = null;
        payload.items[idx] = rec; payload.updated_at = new Date().toISOString();
        this.jobStore[jobName] = payload; this.saveJobsToStorage(); this.refreshJobsArray();
        if (this.jobName === jobName) { this.items[idx] = { ...this.items[idx], ...rec }; this.recomputeDetectedEmails(); }
        // Perform the check
        const systemPrompt = payload?.meta?.systemPrompt || '';
        const result = await this.callBackgroundCheckApi(email, systemPrompt);
          rec.bg_status = result?.status || 'person_low';
          rec.bg_message = result?.message || '';
          if (result && result.fields && typeof result.fields === 'object') {
            for (const [k, v] of Object.entries(result.fields)) rec[k] = v;
          }
          rec.bg_checked_at = new Date().toISOString();
        payload.items[idx] = rec; payload.updated_at = new Date().toISOString();
        this.jobStore[jobName] = payload; this.saveJobsToStorage(); this.refreshJobsArray();
        if (this.jobName === jobName) { this.items[idx] = { ...this.items[idx], ...rec }; this.recomputeDetectedEmails(); }
        this.finishCheckForJob(jobName);
        } catch (e) {
        // Best-effort error capture to the active job if applicable
        try {
          const payload = this.jobStore && this.jobStore[jobName];
          if (!payload) return;
          const items = Array.isArray(payload.items) ? payload.items : [];
          if (idx < 0 || idx >= items.length) return;
          const rec = items[idx]; if (!rec) return;
          rec.bg_status = 'error';
          rec.bg_message = (e && e.message) ? e.message : 'Error';
          rec.bg_checked_at = new Date().toISOString();
          payload.items[idx] = rec; payload.updated_at = new Date().toISOString();
          this.jobStore[jobName] = payload; this.saveJobsToStorage(); this.refreshJobsArray();
          if (this.jobName === jobName) { this.items[idx] = { ...this.items[idx], ...rec }; this.recomputeDetectedEmails(); }
          this.finishCheckForJob(jobName);
        } catch (_) {}
      }
    },
    async runOne(idx) {
      try {
        if (idx < 0 || idx >= (this.items?.length || 0)) return;
        const rec = this.items[idx];
        if (!rec) return;
        if (!this.getRecordEmail(rec)) {
          rec.bg_status = 'error';
          rec.bg_message = 'No email detected';
          rec.bg_checked_at = new Date().toISOString();
          this.saveActiveJob();
          return;
        }
        // Clear prior assessment fields for this row (fully reset)
        delete rec.bg_compound_msg;
        delete rec.bg_compound_debug;
        delete rec.bg_browser_debug;
        delete rec.bg_compound_label;
        delete rec.bg_compound_short;
        delete rec.bg_compound_detail;
        delete rec.bg_browser_label;
        delete rec.bg_browser_short;
        delete rec.bg_browser_detail;
        delete rec.bg_final_label;
        delete rec.bg_final_short;
        delete rec.bg_final_detail;
        delete rec.bg_compound_evidence;
        delete rec.bg_browser_evidence;
        delete rec.bg_final_evidence;
        rec.bg_status = 'checking';
        rec.bg_message = '';
        this.saveActiveJob();
        // Ensure sidebar reflects running state for per-row checks
        try { this._refreshJobRunningMap(); this._watchActiveRunner(); } catch (_) {}
        if (!this.hasServerKey && !this.userApiKey) throw new Error('No Groq API key set. Add a key to run checks.');
        const email = this.getRecordEmail(rec);
        const result = await this.callBackgroundCheckApi(email, this.systemPrompt);
        rec.bg_status = result?.status || 'person_low';
        rec.bg_message = result?.message || '';
        if (result && result.fields && typeof result.fields === 'object') {
          for (const [k, v] of Object.entries(result.fields)) rec[k] = v;
        }
        rec.bg_checked_at = new Date().toISOString();
      } catch (e) {
        const rec = this.items[idx];
        if (rec) {
          rec.bg_status = 'error';
          rec.bg_message = (e && e.message) ? e.message : 'Error';
          rec.bg_checked_at = new Date().toISOString();
        }
      } finally {
        this.saveActiveJob();
        try { this.finishCheckForJob(this.jobName); } catch (_) {}
      }
    },
    cancelRun() {
      this.cancelRequested = true;
      try { if (this.jobName) this.cancelBackgroundRunForJob(this.jobName); } catch (_) {}
      // isRunning will flip false when the runner loop drains; also stop UI watcher
      try { if (this._activeRunnerInterval) { clearInterval(this._activeRunnerInterval); this._activeRunnerInterval = null; } } catch (_) {}
    },
    async runSingleCheck() {
      try {
        const raw = String(this.singleEmailInput || '').trim();
        let email = '';
        if (this.isEmail(raw)) {
          email = raw;
        } else {
          const found = this.extractEmailsFromText(raw);
          email = (found && found.length > 0) ? found[0] : '';
        }
        if (!email) return;
        if (!this.hasServerKey && !this.userApiKey) throw new Error('No Groq API key set. Add a key to run checks.');
        this.singleChecking = true;
        this.singleResult = null;
        // Ensure we have an active job to reflect sidebar state
        this.ensureDefaultJobName('(single)');
        // clear UI debug leftovers and transient fields
        for (const it of (this.items || [])) {
          delete it.bg_compound_debug;
          delete it.bg_browser_debug;
        }
        // Pre-mark target record as checking so sidebar shows spinner
        const key = this.emailKey(email);
        let idx = -1;
        for (let i = 0; i < (this.items?.length || 0); i++) {
          const k = this.emailKey(this.getRecordEmail(this.items[i]));
          if (k && k === key) { idx = i; break; }
        }
        if (idx >= 0) {
          const rec = this.items[idx];
          delete rec.bg_compound_msg;
          delete rec.bg_compound_label;
          delete rec.bg_compound_short;
          delete rec.bg_compound_detail;
          delete rec.bg_browser_label;
          delete rec.bg_browser_short;
          delete rec.bg_browser_detail;
          delete rec.bg_final_label;
          delete rec.bg_final_short;
          delete rec.bg_final_detail;
          delete rec.bg_compound_evidence;
          delete rec.bg_browser_evidence;
          delete rec.bg_final_evidence;
          rec.bg_status = 'checking';
          rec.bg_message = '';
          rec.bg_checked_at = null;
          this.items[idx] = rec;
        } else {
          const rec = {
            email,
            _row_index: (this.items?.length || 0),
            bg_status: 'checking',
            bg_message: '',
            bg_checked_at: null
          };
          this.items = [...(this.items || []), rec];
          this.recomputeDetectedEmails();
          idx = this.items.length - 1;
        }
        this.saveActiveJob();
        try { this._refreshJobRunningMap(); this._watchActiveRunner(); } catch (_) {}

        // Perform the check
        const result = await this.callBackgroundCheckApi(email, this.systemPrompt);
        this.singleResult = result;

        // Update the record with results
        const rec2 = this.items[idx] || { email, _row_index: idx };
        rec2.bg_status = result?.status || 'person_low';
        rec2.bg_message = result?.message || '';
        if (result && result.fields && typeof result.fields === 'object') {
          for (const [k, v] of Object.entries(result.fields)) rec2[k] = v;
        }
        rec2.bg_checked_at = new Date().toISOString();
        this.items[idx] = rec2;
        this.saveActiveJob();
        try { this._refreshJobRunningMap(); } catch (_) {}
      } catch (e) {
        this.singleResult = { email: this.singleEmailInput, status: 'error', message: (e && e.message) ? e.message : 'Error', fields: {} };
      } finally {
        this.singleChecking = false;
        try { this.finishCheckForJob(this.jobName); } catch (_) {}
        // Re-focus the single input for quick subsequent checks
        try { const el = document.querySelector('input[x-ref="singleEmailInputRef"]'); if (el) el.focus(); } catch (_) {}
      }
    },
    // Background check orchestrator — sequentially runs an array of checker functions
    async backgroundCheck(email, prompt) {
      const checkers = this.buildCheckers(prompt);
      const messages = [];
      let status = undefined;
      const fields = {};
      for (const checker of checkers) {
        try {
          // Each checker may be sync or async
          // Shape: { status?, message?, fields? }
          const res = await checker(email);
          if (!res) continue;
          if (res.message) messages.push(String(res.message));
          if (res.fields && typeof res.fields === 'object') Object.assign(fields, res.fields);
          if (res.status) status = this.mergeStatus(status, res.status);
        } catch (_) { /* ignore individual checker errors */ }
      }
      // Fallback classification if still unset
      if (!status) {
        const fb = await this.heuristicFallbackChecker(email);
        status = fb.status;
        if (fb.message) messages.push(fb.message);
      }
      return { status, message: messages.join('; ') || this.statusToMessage(status), fields };
    },

    async callBackgroundCheckApi(email, systemPrompt) {
      const resp = await fetch('/api/check/background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, systemPrompt: systemPrompt || '', userApiKey: this.userApiKey || undefined, whitelist: this.parseListText(this.whitelistText), blacklist: this.parseListText(this.blacklistText) })
      });
      if (!resp.ok) throw new Error(await resp.text().catch(() => resp.statusText));
      return await resp.json();
    },

    parseListText(text) {
      try {
        // Only split on newlines; commas are valid inside regex quantifiers (e.g., {2,4})
        const src = String(text || '').replace(/[\r\n]+/g, '\n');
        const lines = src.split('\n').map(s => String(s || '').trim()).filter(Boolean);
        const seen = new Set();
        const out = [];
        for (const s of lines) { const key = s.startsWith('/') ? s : s.toLowerCase(); if (!seen.has(key)) { seen.add(key); out.push(s); } }
        return out;
      } catch (_) { return []; }
    },

    // Compose the list of checkers to run in order
    buildCheckers(prompt) {
      return [
        // 1) Basic syntax validation
        async (email) => {
          if (!this.isEmail(email)) return { status: 'undeliverable', message: 'Invalid email format' };
          return { status: undefined };
        },
        // 2) Academic domain check (server-assisted)
        async (email) => {
          try {
            const info = await this.checkAcademic(email);
            if (!info) return null;
            const fields = { bg_academic: !!info.isAcademic };
            if (info.institution) fields.bg_institution = info.institution;
            // Academic domains are not penalized; annotate message only
            if (info.isAcademic) {
              const short = info.institution ? String(info.institution) : 'Academic domain';
              fields.bg_academic_msg = short;
              return { message: short, fields };
            }
            return { fields };
          } catch (_) {
            return null;
          }
        },
        // 2b) LLM legitimacy check (optional; annotate + potential status nudge)
        async (email) => {
          try {
            if (!this.userApiKey && !this.hasServerKey) return null;
            const data = await this.callLlmEmailCheck(email, prompt);
            if (!data) return null;
            const out = { fields: data.fields || {}, message: data.message || '' };
            if (data.status && (data.status === 'person_high' || data.status === 'person_low' || data.status === 'person_none' || data.status === 'spam')) {
              out.status = data.status;
            }
            if (out.message) out.fields.bg_compound_msg = out.message;
            return out;
          } catch (_) { return null; }
        },
        // 3) Role/alias heuristic (flag as suspicious)
        async (email) => {
          try {
            const local = String(email || '').split('@')[0].toLowerCase();
            const roleList = ['info', 'support', 'admin', 'sales', 'contact', 'hello', 'team', 'marketing', 'noreply', 'no-reply'];
            if (roleList.includes(local)) return { status: 'person_none', message: 'Role-based address' };
            return null;
          } catch (_) { return null; }
        }
      ];
    },

    async callLlmEmailCheck(email, systemPrompt) {
      try {
        const resp = await fetch('/api/check/llm-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, systemPrompt: systemPrompt || '', userApiKey: this.userApiKey || undefined })
        });
        if (!resp.ok) return null;
        return await resp.json();
      } catch (_) { return null; }
    },

    async heuristicFallbackChecker(email) {
      // Default to person_low when heuristic needed; avoid penalizing good emails
      await new Promise((res) => setTimeout(res, 120 + Math.floor(Math.random() * 300)));
      return { status: 'person_low', message: '' };
    },

    async checkAcademic(email) {
      try {
        const resp = await fetch('/api/check/academic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return { isAcademic: !!data?.isAcademic, institution: data?.institution || null };
      } catch (_) { return null; }
    },

    mergeStatus(current, next) {
      if (!next) return current || undefined;
      if (!current) return next;
      const score = (s) => (s === 'spam' ? 4 : s === 'person_none' ? 3 : s === 'person_low' ? 2 : s === 'person_high' ? 1 : 0);
      return score(next) >= score(current) ? next : current;
    },

    // Display label for statuses (new person confidence scale + legacy)
    statusLabel(status) {
      if (status === 'academic') return 'academic';
      if (status === 'whitelist') return 'whitelist';
      if (status === 'person_high') return 'likely real person';
      if (status === 'person_low') return 'possible person';
      if (status === 'person_none') return 'no evidence';
      if (status === 'spam') return 'spam';
      if (status === 'person_high') return 'likely real person';
      if (status === 'person_low') return 'possible person';
      if (status === 'person_none') return 'no evidence';
      if (status === 'spam') return 'spam';
      if (status === 'checking') return 'checking';
      if (status === 'error') return 'error';
      return String(status || '');
    },
    statusToMessage(status) {
      if (status === 'person_high') return 'Likely real person';
      if (status === 'person_low') return 'Possible person';
      if (status === 'person_none') return 'No public identity evidence';
      if (status === 'spam') return 'Spam or invalid';
      if (status === 'deliverable') return 'Looks good: deliverable address';
      if (status === 'suspicious') return 'Risky patterns: disposable/role-based or malformed parts';
      if (status === 'undeliverable') return 'Likely bounce or spamtrap';
      if (status === 'checking') return 'Checking...';
      if (status === 'error') return 'Error checking email';
      return String(status || '');
    },

    // Downloads
    downloadCsv() {
      try {
        const { headers, rows } = this.buildOutputTable();
        const escapeCsv = (v) => {
          const s = (v === null || v === undefined) ? '' : String(v);
          if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
          return s;
        };
        const out = [headers.map(escapeCsv).join(',')];
        for (const r of rows) out.push(r.map(escapeCsv).join(','));
        const csv = out.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = (this.jobName ? (this.jobName + '_') : '') + 'mailcheck.csv';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (_) {}
    },
    downloadJson() {
      try {
        const arr = this.buildOutputObjects();
        const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = (this.jobName ? (this.jobName + '_') : '') + 'mailcheck.json';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (_) {}
    },
    async copyJson() {
      try { await navigator.clipboard.writeText(JSON.stringify(this.buildOutputObjects(), null, 2)); } catch (_) {}
    },
    buildOutputObjects() {
      // Preserve original fields, plus bg_status and bg_message
      const out = [];
      for (const it of (this.items || [])) {
        const obj = { ...it };
        // Keep explicit fields
        obj.bg_status = it.bg_status || 'pending';
        obj.bg_message = it.bg_message || '';
        obj.bg_checked_at = it.bg_checked_at || null;
        // Remove internal helper fields
        delete obj._row_index;
        out.push(obj);
      }
      return out;
    },
    buildOutputTable() {
      // Construct headers from input headers or dynamic keys
      const rows = [];
      const keysSet = new Set();
      if (Array.isArray(this.sourceHeaders) && this.sourceHeaders.length > 0) {
        for (const h of this.sourceHeaders) keysSet.add(h);
      } else {
        for (const it of (this.items || [])) {
          for (const k of Object.keys(it || {})) {
            if (k === '_row_index' || k === '_editingEmail' || k === '_editEmailValue') continue;
            keysSet.add(k);
          }
        }
      }
      // Ensure email field present
      if (this.emailFieldName && !keysSet.has(this.emailFieldName)) keysSet.add(this.emailFieldName);
      // Add bg fields at end
      const headers = Array.from(keysSet);
      for (const k of ['bg_status', 'bg_message', 'bg_checked_at']) if (!headers.includes(k)) headers.push(k);
      for (const it of (this.items || [])) {
        const row = headers.map((h) => it[h] !== undefined ? it[h] : '');
        rows.push(row);
      }
      return { headers, rows };
    },

    // UI helpers
    get totalCount() { return Array.isArray(this.items) ? this.items.length : 0; },
    get pendingCount() {
      let n = 0;
      for (const it of (this.items || [])) { if (it && (!it.bg_checked_at || it.bg_status === 'pending' || !it.bg_status)) n++; }
      return n;
    },
    get completedCount() {
      let n = 0;
      for (const it of (this.items || [])) {
        if (it && (it.bg_status === 'person_high' || it.bg_status === 'person_low' || it.bg_status === 'person_none' || it.bg_status === 'spam' || it.bg_status === 'not_spam' || it.bg_status === 'suspected_spam' || it.bg_status === 'likely_spam' || it.bg_status === 'academic' || it.bg_status === 'whitelist' || it.bg_status === 'error')) n++;
      }
      return n;
    },
    badgeClass(status) {
      if (status === 'person_high' || status === 'not_spam' || status === 'academic' || status === 'whitelist') return 'bg-green-100 text-green-800 border-green-200';
      if (status === 'person_low' || status === 'suspected_spam') return 'bg-amber-100 text-amber-800 border-amber-200';
      if (status === 'person_none') return 'bg-gray-100 text-gray-800 border-gray-300';
      if (status === 'spam' || status === 'likely_spam' || status === 'error') return 'bg-red-100 text-red-800 border-red-200';
      if (status === 'checking') return 'bg-blue-100 text-blue-800 border-blue-200';
      return 'bg-gray-100 text-gray-800 border-gray-200';
    },

    // i18n
    get i18n() {
      return {
        title: 'Email Background Checker',
        subtitle: 'Upload or paste emails; verify they belong to real people.',
        apiKey: 'API Key:', change: 'Change', clear: 'Clear', getKeyHere: 'Get your free key here'
      };
    }
  };
  try { _attachWatchActiveRunner(inst); } catch (_) {}
  return inst;
}

// createJobRunner
// A small, copyable background runner that processes a single job's items with
// controlled concurrency. It runs independently from UI state and persists
// progress safely back into app.jobStore[jobName].
//
// Usage:
//   const runner = createJobRunner(app, 'my-job', { concurrency: 8, onlyPending: true });
//   runner.start();
//   runner.cancel();
//   const s = runner.status(); // { running, cancelled, total, completed }
function createJobRunner(app, jobName, options = {}) {
  // Internal runner state — not reactive
  const state = {
    running: false,
    cancelled: false,
    total: 0,
    completed: 0
  };

  // Persist the updated job payload back to localStorage via app helpers,
  // refresh sidebar job counts, and live-update the UI list if this job is active.
  function persistAndMaybeUpdateUi(updatedPayload, idx) {
    try {
      app.jobStore[jobName] = updatedPayload;
      app.saveJobsToStorage();
      app.refreshJobsArray();
      if (app.jobName === jobName) {
        const uiItems = app.items || [];
        const jobItems = updatedPayload.items || [];
        if (idx >= 0 && idx < jobItems.length && idx < uiItems.length) {
          const updated = jobItems[idx];
          // Basic defensive sync by index
          app.items[idx] = { ...app.items[idx], ...updated };
        }
        app.recomputeDetectedEmails();
      }
    } catch (_) {}
  }

  // Build the list of indices to process for the job
  function collectTargetIndices(items) {
    const onlyPending = options.onlyPending !== false;
    const indices = [];
    for (let i = 0; i < (items?.length || 0); i++) {
      const it = items[i];
      if (!it) continue;
      if (!onlyPending) { indices.push(i); continue; }
      const pending = (!it.bg_checked_at || it.bg_status === 'pending' || !it.bg_status);
      if (pending) indices.push(i);
    }
    return indices;
  }

  async function start() {
    if (state.running) return;
    state.running = true;
    state.cancelled = false;
    try {
      const payload = app.jobStore && app.jobStore[jobName] ? { ...app.jobStore[jobName] } : null;
      if (!payload) { state.running = false; return; }
      const items = Array.isArray(payload.items) ? payload.items.slice() : [];
      const systemPrompt = payload?.meta?.systemPrompt || '';
      const indices = collectTargetIndices(items);
      state.total = indices.length;
      state.completed = 0;
      if (indices.length === 0) { state.running = false; return; }

      // Pre-mark queued rows as checking (or error if no email) and persist
      for (const idx of indices) {
        const rec = items[idx];
        if (!rec) continue;
        const email = app.getRecordEmail ? app.getRecordEmail(rec) : (rec.email || '');
        // Clear previous per-check transient fields
        delete rec.bg_compound_msg; delete rec.bg_compound_debug; delete rec.bg_browser_debug;
        delete rec.bg_compound_label; delete rec.bg_compound_short; delete rec.bg_compound_detail;
        delete rec.bg_browser_label; delete rec.bg_browser_short; delete rec.bg_browser_detail;
        delete rec.bg_compound_evidence; delete rec.bg_browser_evidence; delete rec.bg_final_evidence;
        if (!email || !(app.isEmail && app.isEmail(email))) {
          rec.bg_status = 'error';
          rec.bg_message = 'No email detected';
          rec.bg_checked_at = new Date().toISOString();
        } else {
          rec.bg_status = 'checking';
          rec.bg_message = '';
          rec.bg_checked_at = null;
        }
        payload.items[idx] = rec; payload.updated_at = new Date().toISOString();
        persistAndMaybeUpdateUi(payload, idx);
      }

      const limit = Math.max(1, Number(options.concurrency || app.concurrency) || 8);
      let cursor = 0;
      const runNext = async () => {
        if (state.cancelled) return;
        if (cursor >= indices.length) return;
        const idx = indices[cursor++];
        const rec = items[idx];
        if (!rec) { state.completed++; return runNext(); }
        if (rec.bg_status === 'error') { state.completed++; return runNext(); }
        try {
          const email = app.getRecordEmail ? app.getRecordEmail(rec) : (rec.email || '');
          if (!app.hasServerKey && !app.userApiKey) throw new Error('No Groq API key set. Add a key to run checks.');
          // Fully clear any previous assessment fields before each call
          delete rec.bg_compound_msg; delete rec.bg_compound_debug; delete rec.bg_browser_debug;
          delete rec.bg_compound_label; delete rec.bg_compound_short; delete rec.bg_compound_detail;
          delete rec.bg_browser_label; delete rec.bg_browser_short; delete rec.bg_browser_detail;
          delete rec.bg_final_label; delete rec.bg_final_short; delete rec.bg_final_detail;
          delete rec.bg_compound_evidence; delete rec.bg_browser_evidence; delete rec.bg_final_evidence;
          const result = await app.callBackgroundCheckApi(email, systemPrompt);
          rec.bg_status = result?.status || 'person_low';
          rec.bg_message = result?.message || '';
          if (result && result.fields && typeof result.fields === 'object') {
            for (const [k, v] of Object.entries(result.fields)) rec[k] = v;
          }
          rec.bg_checked_at = new Date().toISOString();
        } catch (e) {
          rec.bg_status = 'error';
          rec.bg_message = (e && e.message) ? e.message : 'Error';
          rec.bg_checked_at = new Date().toISOString();
        } finally {
          // Write back the single record and persist
          payload.items[idx] = rec;
          payload.updated_at = new Date().toISOString();
          persistAndMaybeUpdateUi(payload, idx);
          state.completed++;
          await runNext();
        }
      };
      const runners = [];
      for (let k = 0; k < limit; k++) runners.push(runNext());
      await Promise.all(runners);
    } catch (_) {
      // swallow
    } finally {
      state.running = false;
    }
  }

  function cancel() { state.cancelled = true; }
  function status() { return { running: state.running, cancelled: state.cancelled, total: state.total, completed: state.completed }; }

  return { start, cancel, status };
}

// UI helper: watch the active job runner state and reflect it in isRunning
// Stops automatically when the runner finishes or job changes
// (attached to the component instance via function expression to access `this`)
mailcheckApp.prototype = mailcheckApp.prototype || {};
// Attach as method on the returned object instead (Alpine pattern)
// eslint-disable-next-line no-unused-vars
function _attachWatchActiveRunner(instance) {
  instance._watchActiveRunner = function () {
    try { if (this._activeRunnerInterval) { clearInterval(this._activeRunnerInterval); this._activeRunnerInterval = null; } } catch (_) {}
    this._activeRunnerInterval = setInterval(() => {
      try {
        const s = this.getBackgroundRunStatus(this.jobName);
        this.isRunning = !!(s && s.running);
        // Keep a per-job map for sidebar indicators
        this._refreshJobRunningMap();
        // Stop watcher when no jobs are active or checking
        let anyRunning = false;
        try { anyRunning = Object.values(this.jobRunningMap || {}).some(Boolean); } catch (_) { anyRunning = this.isRunning; }
        if (!anyRunning) { clearInterval(this._activeRunnerInterval); this._activeRunnerInterval = null; }
      } catch (_) {
        try { clearInterval(this._activeRunnerInterval); this._activeRunnerInterval = null; } catch (_) {}
      }
    }, 400);
  };
}
// (wrapper removed) — default export is now the single factory with watcher injection



