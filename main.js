import { Hono } from 'https://deno.land/x/hono@v3.11.12/mod.ts';
import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { listFiles, readFile } from "https://esm.town/v/std/utils/index.ts";
import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown
import { groqChatCompletion } from "./chatCompletion.js";
import { backgroundAssessEmail } from "./backend/assessments/main.js";

const app = new Hono();
const serverApiKey = null; // Deno.env.get("GROQ_API_KEY");

// Settings configuration (minimal)
const settings = {};

// In-memory async job registry (ephemeral per process)
const jobRegistry = new Map(); // jobId -> { id, running, cancelled, total, completed, createdAt, updatedAt, items: [{ id, email, status, result?, error? }], systemPrompt }

function generateId() {
  try { return crypto.randomUUID(); } catch (_) { return (Date.now().toString(36) + Math.random().toString(36).slice(2)); }
}

function nowTs() { return Date.now(); }

function summarizeJob(job) {
  return {
    id: job.id,
    running: !!job.running,
    cancelled: !!job.cancelled,
    total: job.total | 0,
    completed: job.completed | 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    systemPrompt: job.systemPrompt || '',
    items: job.items.map((it) => ({ id: it.id, email: it.email, status: it.status, result: it.result || null, error: it.error || null }))
  };
}

async function runAsyncJob(job, apiKey, concurrency) {
  if (!Array.isArray(job.items) || job.items.length === 0) { job.running = false; job.updatedAt = nowTs(); return; }
  job.running = true; job.cancelled = false; job.updatedAt = nowTs();
  const systemPrompt = job.systemPrompt || '';
  const indices = job.items.map((_, i) => i);
  job.total = indices.length; job.completed = 0;

  // Pre-mark pending as checking
  for (const idx of indices) {
    const it = job.items[idx];
    if (!it) continue;
    if (it.status === 'done' || it.status === 'error') continue;
    it.status = 'checking';
  }
  job.updatedAt = nowTs();

  const limit = Math.max(1, Number(concurrency || 8) || 8);
  let cursor = 0;
  const runNext = async () => {
    if (job.cancelled) return;
    if (cursor >= indices.length) return;
    const idx = indices[cursor++];
    const item = job.items[idx];
    if (!item) return runNext();
    if (item.status === 'done' || item.status === 'error') { job.completed++; return runNext(); }
    try {
      const res = await backgroundAssessEmail(apiKey, item.email, systemPrompt);
      item.result = res;
      item.status = 'done';
    } catch (err) {
      item.error = err && err.message ? err.message : String(err);
      item.status = 'error';
    } finally {
      job.completed++;
      job.updatedAt = nowTs();
      await runNext();
    }
  };
  const runners = [];
  for (let k = 0; k < limit; k++) runners.push(runNext());
  try { await Promise.all(runners); } catch (_) {}
  job.running = false; job.updatedAt = nowTs();
}


// Helper: Collect readable text from tool records for URL-grounded extraction
function collectToolTextFromArray(toolArray) {
  if (!Array.isArray(toolArray)) return '';
  const parts = [];
  for (const t of toolArray) {
    try {
      const name = t?.name || t?.tool || t?.function?.name || t?.id || '';
      const args = t?.arguments || t?.input || t?.params || null;
      const output = t?.output || t?.result || t?.content || null;
      const searchResults = t?.search_results || t?.results || null;
      if (name) parts.push('name: ' + String(name));
      if (args) parts.push('arguments: ' + (typeof args === 'string' ? args : JSON.stringify(args)));
      if (output) parts.push('output: ' + (typeof output === 'string' ? output : JSON.stringify(output)));
      if (searchResults) parts.push('search_results: ' + (typeof searchResults === 'string' ? searchResults : JSON.stringify(searchResults)));
    } catch (_) {
      // ignore malformed tool objects
    }
  }
  return parts.join('\n');
}



// Reusable background-check helpers
function isEmailAddress(s) {
  const str = String(s || '').trim();
  if (!str) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str);
}
function mergeSpamStatus(current, next) {
  if (!next) return current || undefined;
  if (!current) return next;
  const score = (s) => (s === 'likely_spam' ? 3 : s === 'suspected_spam' ? 2 : s === 'not_spam' ? 1 : 0);
  return score(next) >= score(current) ? next : current;
}
function mergeStatus(current, next) {
  if (!next) return current || undefined;
  if (!current) return next;
  const score = (s) => (s === 'spam' ? 4 : s === 'person_none' ? 3 : s === 'person_low' ? 2 : s === 'person_high' ? 1 : 0);
  return score(next) >= score(current) ? next : current;
}
function extractJsonBetweenTags(text) {
  try {
    if (!text) return null;
    const m = String(text).match(/<json>[\s\S]*?<\/json>/i);
    const slice = m ? m[0] : null;
    if (!slice) return null;
    const inner = slice.replace(/^<json>/i, '').replace(/<\/json>$/i, '');
    const trimmed = inner.trim();
    return JSON.parse(trimmed);
  } catch (err) { 
    console.error('Failed to parse JSON between tags:', trimmed, 'Error:', err.message);
    return null; 
  }
}
function logGroqCurl(tag, apiKey, payload) {
  try {
    const compact = JSON.stringify(payload);
    const esc = compact.replace(/'/g, `'"'"'`);
    const curl = [
      'curl --request POST \\\n' +
      '    --url https://api.groq.com/openai/v1/chat/completions \\\n' +
      `    --header 'authorization: Bearer ${apiKey}' \\\n` +
      "    --header 'content-type: application/json' \\\n" +
      `    --data '${esc}'`
    ].join('');
    console.log(`>> [${tag}] curl script:\n${curl}`);
  } catch (_) {}
}
function coerceJsonFromText(text) {
  try {
    if (!text) return null;
    // 1) Try to find a raw JSON object substring
    const raw = String(text);
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = raw.slice(firstBrace, lastBrace + 1);
      try { return JSON.parse(candidate); } catch (_) {}
    }
    // 2) Try loose key extraction
    const statusMatch = raw.match(/status\s*[:=]\s*["']?([a-zA-Z_]+)["']?/);
    const messageMatch = raw.match(/message\s*[:=]\s*["']([^"']+)["']/);
    const explMatch = raw.match(/explanation_short\s*[:=]\s*["']([^"']+)["']/);
    const out = {};
    if (statusMatch) out.status = statusMatch[1];
    if (messageMatch) out.message = messageMatch[1];
    if (explMatch) out.explanation_short = explMatch[1];
    return Object.keys(out).length > 0 ? out : null;
  } catch (_) { return null; }
}

function getEmailDomain(address) {
  try { return String(address || '').split('@')[1]?.toLowerCase() || ''; } catch (_) { return ''; }
}
function isGenericEmailDomain(domain) {
  const generic = new Set(['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','gmx.com','aol.com','proton.me','protonmail.com','mail.com','yandex.com']);
  return generic.has(String(domain || '').toLowerCase());
}
function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of (arr || [])) { const v = String(s || '').trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}
// Whitelist helpers
function normalizeWhitelistTokens(list) {
  try {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const t = String(raw || '').trim().toLowerCase();
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  } catch (_) { return []; }
}
function domainMatches(supplied, actualDomain) {
  try {
    const d = String(actualDomain || '').toLowerCase();
    const token = String(supplied || '').toLowerCase();
    if (!token || !d) return false;
    const t = token.replace(/^\*@/, '').replace(/^@/, '');
    if (!t) return false;
    if (d === t) return true;
    // allow subdomain suffix matches
    return d.endsWith('.' + t);
  } catch (_) { return false; }
}
function matchWhitelist(email, tokens) {
  try {
    const e = String(email || '').toLowerCase();
    const domain = getEmailDomain(e);
    const list = normalizeWhitelistTokens(tokens);
    for (const t of list) {
      if (!t) continue;
      if (t.includes('@') && !t.includes('*')) {
        // exact email or @domain
        if (t.startsWith('@')) { if (domainMatches(t, domain)) return t; }
        else if (e === t) return t;
      } else if (t.startsWith('*@')) {
        if (domainMatches(t, domain)) return t;
      } else if (t.startsWith('@')) {
        if (domainMatches(t, domain)) return t;
      } else if (t.includes('.')) {
        // bare domain like example.com
        if (domainMatches(t, domain)) return t;
      }
    }
    return null;
  } catch (_) { return null; }
}
function statusToLabel(status) {
  if (status === 'spam') return 'spam';
  if (status === 'person_none') return 'no evidence';
  if (status === 'person_low') return 'possible person';
  if (status === 'likely_spam') return 'spam';
  if (status === 'suspected_spam') return 'suspicious';
  if (status === 'not_spam' || status === 'person_high') return 'likely real person';
  return String(status || '');
}
function cleanDetailText(text) {
  try {
    if (!text) return '';
    let s = String(text);
    // Remove tool and output blocks often present in compound traces
    s = s.replace(/<tool>[\s\S]*?<\/tool>/gi, '').replace(/<output>[\s\S]*?<\/output>/gi, '');
    // Drop embedded JSON blocks
    s = s.replace(/<json>[\s\S]*?<\/json>/gi, '');
    // Normalize whitespace
    s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // Keep only 1-3 short paragraphs
    const paras = s.split(/\n\s*\n/).filter(p => p && p.trim());
    const limited = paras.slice(0, 3).map(p => p.trim().slice(0, 500));
    const joined = limited.join('\n\n').trim();
    return joined.slice(0, 1400);
  } catch (_) { return ''; }
}

// Produce a concise one-sentence identity-first summary from an explanation
function deriveIdentityShort(explanation) {
  try {
    if (!explanation) return '';
    let s = String(explanation).trim();
    // Take the first sentence
    try {
      const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
      if (parts.length > 0) s = parts[0];
    } catch (_) {}
    // Length guard
    if (s.length > 200) s = s.slice(0, 199).replace(/[,;:\s]+$/, '').trim() + '…';
    return s;
  } catch (_) { return ''; }
}

// Convert a plain-text analysis (Status/Message/Explanation/Evidence sections) into strict JSON
// Schema: { status: 'person_high|person_low|person_none|spam', message: string, explanation_short: string, evidence: string[] }
async function convertAnalysisToJson(apiKey, email, analysisText) {
  try {
    const convModel = 'openai/gpt-oss-20b';
    const convSys = [
      'You convert analysis text into a strict JSON object. Do not browse or call tools.',
      'Schema: { "status": "person_high|person_low|person_none|spam", "message": string, "explanation_short": string, "evidence": string[] }',
      'Rules:',
      '- message: one short sentence.',
      '- explanation_short: 2-3 sentences (<= 400 chars). If analysis indicates nothing credible was found, include "No public evidence found." If known, include person background (name, role/title, organization). If credible negative signals are present (e.g., StopForumSpam, Spamhaus, scam-reporting communities), mention that.',
      '- evidence: 0-5 short bullets (no links). Include a background bullet when available (e.g., "Name — Title, Organization, City"). Include negative bullets when applicable (e.g., "Flagged on StopForumSpam"). Use [] when no credible evidence.',
      '- Only output a JSON object (no markdown, no extra text).'
    ].join('\n');
    const convMessages = [
      { role: 'system', content: convSys },
      { role: 'user', content: 'Email: ' + email + '\nAnalysis to convert:\n' + analysisText }
    ];
    const convPayload = { model: convModel, messages: convMessages, stream: false, temperature: 0, response_format: { type: 'json_object' }, tool_choice: 'none' };
    const convRes = await groqChatCompletion(apiKey, convPayload);
    const t2 = convRes?.choices?.[0]?.message?.content || '';
    try { return JSON.parse(t2); } catch (_) { return null; }
  } catch (_) {
    return null;
  }
}
async function llmCompoundAssess(apiKey, email, systemPrompt) {
  const baseSystem = [
    'You assess whether an email belongs to a real person. Perform targeted web checks. If you cannot browse, reason only from public patterns in the address and provider; do not fabricate.',
    'Make an effort to look for identity signals on LinkedIn, company/staff pages, academic directories, GitHub, personal sites, press/newsroom/author pages, and social profiles.',
    'When identity is indicated, do light background digging: capture the person\'s name, role/title, organization, department/team, and location/city if available.',
    'Also look for negative signals: credible anti-abuse/anti-spam sources (e.g., StopForumSpam, Spamhaus, PhishTank), scam-reporting communities, or reputable media coverage indicating misuse. If credible negative signals exist, prefer status: spam.',
    'Return ONLY JSON wrapped in <json>...</json> tags using this schema:',
    '{ "status": "person_high|person_low|person_none|spam", "message": string, "explanation_short": string, "evidence": string[] }',
    'Guidelines:',
    '- person_high: strong identity signals clearly tie to the email/user (e.g., staff or author page, LinkedIn with matching name and employer, academic page listing the email).',
    '- person_low: weak or indirect signals; likely a person but unverified.',
    '- person_none: no public identity evidence.',
    '- spam: obvious spam/role-based/throwaway patterns, or credible anti-spam sources flag the address.',
    '- Leniency: If the domain appears to be a non-generic organization or an academic domain (e.g., .edu, .ac.*, or a known university/company), and there are weak but plausible signals (name match, role on org page without explicit email), lean toward person_low rather than person_none.',
    '- Escalation: When you find a plausible identity match (person name plus role/title and/or organization/institution) from credible sources and there are no credible negative signals, prefer status: person_high, even if the address uses a generic email provider (e.g., gmail).',
    '- message: one short sentence preferring an identity-first summary, e.g., "Linked to Name — Title, Organization" when available. explanation_short: 2-3 sentences (<= 400 chars), plain text; no tool logs, URLs, or headings. If known, include person background (name, role/title, organization).',
    '- evidence: 1-5 short bullets summarizing concrete findings (no links). Include at least one background bullet when available (e.g., "Name — Title, Organization, City"). Include negative bullets when applicable (e.g., "Flagged on StopForumSpam" or "Reported in scam community"). If nothing found, set evidence to [] and explicitly state "No public evidence found." in explanation_short.',
    '- If the address indicates a role (e.g., info, noreply) or a notable role (e.g., reporter, journalist, professor, founder), include that in evidence.',
    '- Do not include any text outside the <json>...</json> wrapper.'
  ].join('\n');
  const messages = [
    { role: 'system', content: baseSystem + (systemPrompt ? ('\nExtra instructions: ' + systemPrompt) : '') },
    { role: 'user', content: 'Email: ' + email + '\nTask: quick legitimacy check.' }
  ];
  const model = 'compound-beta';
  const compoundPayload1 = { model, messages, stream: false, temperature: 0.2, tool_choice: 'none' };
  const r1 = await groqChatCompletion(apiKey, compoundPayload1);
  // logGroqCurl('compound r1', apiKey, compoundPayload1);
  // try { console.log('>> [compound] r1:', JSON.stringify(r1)); } catch (_) {}
  const t1 = r1?.choices?.[0]?.message?.content || '';
  const reasoning1 = r1?.choices?.[0]?.message?.reasoning || '';
  let parsed = extractJsonBetweenTags(t1);
  if (!parsed) {
    // In JSON mode, remove the <json> wrapper instruction to avoid tool_use_failed
    const baseSystemJson = [
      'You assess whether an email likely belongs to a real person based on quick web checks; do not fabricate.',
      'Return ONLY a JSON object with this schema (no tags, no markdown):',
      '{ "status": "person_high|person_low|person_none|spam", "message": string, "explanation_short": string, "evidence": string[] }',
      'Keep message concise; explanation_short 2-3 sentences (<= 400 chars).'
    ].join('\n');
    const messagesJson = [
      { role: 'system', content: baseSystemJson + (systemPrompt ? ('\nExtra instructions: ' + systemPrompt) : '') },
      { role: 'user', content: 'Email: ' + email + '\nTask: quick legitimacy check.' }
    ];
    const payload2 = { model, messages: messagesJson, stream: false, temperature: 0.2, response_format: { type: 'json_object' }, tool_choice: 'none' };
    // logGroqCurl('compound r2', apiKey, payload2);
    const r2 = await groqChatCompletion(apiKey, payload2);
    try { console.log('>> [compound] r2:', JSON.stringify(r2)); } catch (_) {}
    const t2 = r2?.choices?.[0]?.message?.content || '';
    try { parsed = JSON.parse(t2); } catch (_) { parsed = null; }
    if (!parsed) {
      return {
        status: 'person_low',
        message: 'no compound signal',
        fields: { bg_compound_debug: (t1 || t2 || '').slice(0, 800), bg_llm_model: model }
      };
    }
  }
  const out = { fields: { bg_llm_model: model } };
  if (parsed) {
    if (parsed.status && (parsed.status === 'person_high' || parsed.status === 'person_low' || parsed.status === 'person_none' || parsed.status === 'spam')) out.status = parsed.status;
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      out.message = parsed.message.trim();
    } else if (out.status) {
      const label = statusToLabel(out.status);
      out.message = 'compound: ' + label;
    } else {
      out.message = 'compound: ' + statusToLabel('person_low');
    }
    // Add compact label + short/long messages
    const label = statusToLabel(out.status || (parsed.status || 'person_low'));
    out.fields.bg_compound_label = label;
    out.fields.bg_compound_short = out.message || label;
    // Prefer model-provided reasoning if available, else raw content stripped of JSON tags
    let detail = '';
    if (typeof parsed.explanation_short === 'string' && parsed.explanation_short.trim()) {
      detail = cleanDetailText(parsed.explanation_short);
      // further limit to ~2-3 sentences / 450 chars
      try {
        const parts = detail.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3);
        detail = parts.join(' ');
        if (detail.length > 450) detail = detail.slice(0, 449).replace(/[,;:\s]+$/, '').trim() + '…';
      } catch (_) {}
    }
    if (!detail && reasoning1 && typeof reasoning1 === 'string') {
      detail = cleanDetailText(reasoning1);
    }
    if (!detail && t1) {
      detail = cleanDetailText(String(t1));
    }
    if (detail) out.fields.bg_compound_detail = detail;
    // Prefer an identity-first short derived from explanation when available
    try {
      const shortPref = (typeof parsed.explanation_short === 'string' && parsed.explanation_short.trim()) ? deriveIdentityShort(parsed.explanation_short) : '';
      if (shortPref) out.fields.bg_compound_short = shortPref;
    } catch (_) {}
    // Evidence list
    try {
      let ev = parsed.evidence;
      if (Array.isArray(ev)) {
        ev = ev.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5);
      } else if (typeof ev === 'string' && ev.trim()) {
        ev = [ev.trim()];
      } else {
        ev = [];
      }
      if (ev.length > 0) out.fields.bg_compound_evidence = ev;
    } catch (_) {}
  }
  return out;
}

// Browser search assessor using Groq's browser_search tool
async function browserSearchAssess(apiKey, email, systemPrompt) {
  const baseSystem = [
    'Use web browsing to gather public signals about whether this email belongs to a real person; do not fabricate.',
    'Call browser_search with multiple targeted queries. Try: the full email in quotes; the local part and domain; site:linkedin.com with likely name/handle; site:github.com with the handle; university/staff directories; newsroom/author pages; personal sites; press pages.',
    'Prefer authoritative sources: LinkedIn, staff/author/company pages, academic directories, GitHub, reputable media. Also check credible anti-abuse/anti-spam sources (StopForumSpam, Spamhaus, PhishTank) and scam-reporting communities. Avoid data brokers and spammy aggregators.',
    'When identity is indicated, do light background digging: capture the person\'s name, role/title, organization, department/team, and location/city if available.',
    'Leniency rule: If the domain appears to be a non-generic organization or academic domain (e.g., .edu, .ac.*, or a recognized university/company), and you find weak but plausible signals (name on org page, directory listing without explicit email, matching role), prefer Status: person_low over person_none unless there are credible negative signals.',
    'Escalation rule: If you find a plausible identity match (person name plus role/title and/or organization/institution) from credible sources and no credible negative signals, prefer Status: person_high, even when the address uses a generic provider (e.g., gmail).',
    'Produce a concise plain-text analysis with the following sections only (do not include any JSON):',
    'Status: one of person_high | person_low | person_none | spam',
    'Message: one short sentence preferring an identity-first summary, e.g., "Linked to Name — Title, Organization" when available',
    'Explanation: 2-3 sentences (<= 400 chars), reference evidence or say No public evidence found. If known, include person background (name, role/title, organization).',
    'Evidence: 1-5 short bullet points summarizing concrete findings (no links). Include at least one bullet with person background when available (e.g., "Name — Title, Organization, City"). Include negative bullets such as "Flagged on StopForumSpam" or "Mentioned in scam-reporting community" when applicable. If nothing credible found, leave this section empty.',
    'Also note recognizable roles when present (reporter, journalist, professor, founder, recruiter).'
  ].join('\n');
  const messages = [
    { role: 'system', content: baseSystem + (systemPrompt ? ('\nExtra instructions: ' + systemPrompt) : '') },
    { role: 'user', content: 'Email: ' + email + '\nTask: web search legitimacy check.' }
  ];
  const model = 'openai/gpt-oss-20b';
  const payload = { model, messages, stream: false, temperature: 0.2, tools: [{ type: 'browser_search' }] };
  const r1 = await groqChatCompletion(apiKey, payload);
  logGroqCurl('browser r1', apiKey, payload);
  // try { console.log('>> [browser] r1:', JSON.stringify(r1)); } catch (_) {}
  const t1 = r1?.choices?.[0]?.message?.content || '';
  const out = { fields: { bg_browser_model: model } };
  // Second pass: convert the plain-text analysis to strict JSON
  let parsed = await convertAnalysisToJson(apiKey, email, t1);

  if (!parsed) {
    // As a last resort, attempt to coerce
    parsed = coerceJsonFromText(t1);
  }

  if (parsed) {
    if (parsed.status && (parsed.status === 'person_high' || parsed.status === 'person_low' || parsed.status === 'person_none' || parsed.status === 'spam')) out.status = parsed.status;
    if (typeof parsed.message === 'string' && parsed.message.trim()) out.message = parsed.message.trim();
    const label = statusToLabel(out.status || (parsed.status || 'person_low'));
    out.fields.bg_browser_label = label;
    out.fields.bg_browser_short = out.message || label;
    if (typeof parsed.explanation_short === 'string' && parsed.explanation_short.trim()) {
      let detail = String(parsed.explanation_short).trim();
      if (detail.length > 450) detail = detail.slice(0, 449).replace(/[,;:\s]+$/, '').trim() + '…';
      out.fields.bg_browser_detail = detail;
      // Prefer identity-first short if explanation is present
      try {
        const shortPref = deriveIdentityShort(parsed.explanation_short);
        if (shortPref) out.fields.bg_browser_short = shortPref;
      } catch (_) {}
    }
    try {
      let ev = parsed.evidence;
      if (Array.isArray(ev)) {
        ev = ev.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5);
      } else if (typeof ev === 'string' && ev.trim()) {
        ev = [ev.trim()];
      } else {
        ev = [];
      }
      if (ev.length > 0) out.fields.bg_browser_evidence = ev;
    } catch (_) {}
  } else {
    out.fields.bg_browser_debug = 'browser_search produced non-JSON analysis and conversion failed.';
  }

  return out;
}

// Final judge to consolidate all signals
async function finalJudgeAssess(apiKey, email, systemPrompt, evidence) {
  console.log('>> [final judge] evidence:', email, JSON.stringify(evidence));
  const model = 'openai/gpt-oss-120b';
  const schema = '{ "status": "person_high|person_low|person_none|spam", "message": string, "explanation_short": string, "evidence": string[] }';
  const sys = [
    'You are a strict judge that consolidates signals from two assessors and heuristics (academic, role, domain) to decide if an email belongs to a real person.',
    'Decide using severity: spam > person_none > person_low > person_high.',
    'Return ONLY JSON per schema:', schema,
    'Rules:',
    '- Compose evidence as a deduplicated list of concrete bullets merged from all inputs (no links).',
    '- Include at least one bullet with person background when available (name, role/title, organization, location).',
    '- If credible anti-spam signals exist (e.g., StopForumSpam, Spamhaus, scam-reporting communities), prefer status: spam and include a negative bullet.',
    '- Leniency: For non-generic organization or academic domains with weak but plausible identity signals, prefer person_low over person_none unless negative signals exist.',
    '- Escalation: If there is a plausible identity match (person name plus role/title and/or organization/institution) from credible sources and no credible negative signals, prefer person_high even if the address uses a generic provider (e.g., gmail).',
    '- If no credible public evidence is present, set evidence to [] and explicitly say "No public evidence found." in explanation_short.',
    '- message must be one short, specific sentence preferring an identity-first summary like "Linked to Name — Title, Organization" when available. explanation_short must be 2-3 sentences (<= 400 chars) and reference key evidence or lack thereof. If known, weave in person background (name, role/title, organization).',
    '- Note recognizable roles when present (reporter, journalist, professor, founder, recruiter).'
  ].join('\n');
  const user = [
    'Email: ' + email,
    'Evidence (JSON):',
    JSON.stringify(evidence)
  ].join('\n');
  // Ask for json_object to avoid extra parsing
  const judgePayload = { model, messages: [ { role: 'system', content: sys + (systemPrompt ? ('\nExtra: ' + systemPrompt) : '') }, { role: 'user', content: user } ], stream: false, temperature: 0.2, response_format: { type: 'json_object' } };
  // logGroqCurl('judge', apiKey, judgePayload);
  const r = await groqChatCompletion(apiKey, judgePayload);
  // try { console.log('>> [judge] r:', JSON.stringify(r)); } catch (_) {}
  let parsed = null;
  try { parsed = JSON.parse(r?.choices?.[0]?.message?.content || '{}'); } catch (_) { parsed = null; }
  if (!parsed) return {};
  const out = { fields: { bg_final_model: model } };
  if (parsed.status && (parsed.status === 'person_high' || parsed.status === 'person_low' || parsed.status === 'person_none' || parsed.status === 'spam')) out.status = parsed.status;
  if (typeof parsed.message === 'string' && parsed.message.trim()) out.message = parsed.message.trim();
  const label = statusToLabel(out.status || (parsed.status || 'person_low'));
  out.fields.bg_final_label = label;
  out.fields.bg_final_short = out.message || label;
  if (typeof parsed.explanation_short === 'string' && parsed.explanation_short.trim()) {
    let d = String(parsed.explanation_short).trim();
    if (d.length > 450) d = d.slice(0, 449).replace(/[,;:\s]+$/, '').trim() + '…';
    out.fields.bg_final_detail = d;
    // Prefer identity-first one-liner for the short summary
    try {
      const shortPref = deriveIdentityShort(parsed.explanation_short);
      if (shortPref) out.fields.bg_final_short = shortPref;
    } catch (_) {}
  }
  try {
    let ev = parsed.evidence;
    if (Array.isArray(ev)) {
      ev = ev.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5);
    } else if (typeof ev === 'string' && ev.trim()) {
      ev = [ev.trim()];
    } else {
      ev = [];
    }
    if (ev.length > 0) out.fields.bg_final_evidence = ev;
  } catch (_) {}
  return out;
}
async function academicAssess(email) {
  const out = { fields: {} };
  try {
    const { Verifier } = await import('npm:academic-email-verifier');
    let isAcademic = false; let institution = null;
    try { isAcademic = await Verifier.isAcademic(email); } catch (_) { isAcademic = false; }
    try { institution = await Verifier.getInstitutionName(email); } catch (_) { institution = null; }
    const inst = typeof institution === 'string' ? institution.trim() : (institution ? String(institution) : null);
    out.fields.bg_academic = !!isAcademic; if (inst) out.fields.bg_institution = inst;
    if (isAcademic) out.fields.bg_academic_msg = inst || 'Academic domain';
  } catch (_) {}
  return out;
}
function roleHeuristicAssess(email) {
  try {
    const local = String(email || '').split('@')[0].toLowerCase();
    const roleList = ['info', 'support', 'admin', 'sales', 'contact', 'hello', 'team', 'marketing', 'noreply', 'no-reply'];
    if (roleList.includes(local)) return { status: 'suspected_spam', message: 'Role-based address' };
  } catch (_) {}
  return {};
}


// Check if server has API key
app.get('/api/check-key', (c) => {
  return c.json({ hasServerKey: !!serverApiKey });
});

// Environment-aware file reading function
async function readFileContent(filePath) {
  // Check if we're in Val Town environment
  if (typeof Deno !== "undefined" && Deno.env.get("valtown")) {
    // Use Val Town's readFile
    return await readFile(filePath, import.meta.url);
  } else {
    // Use Deno's native readTextFile for local development
    return await Deno.readTextFile(filePath);
  }
}

// Serve root with HTML content
app.get('/', async (c) => {
  try {
    const htmlContent = await readFileContent('index.html');
    return c.html(htmlContent);
  } catch (error) {
    console.error('Error reading HTML file:', error);
    return c.text('Error loading page', 500);
  }
});

// Serve frontend modules (no static middleware)
// Removed legacy research frontend

app.get('/frontend/init.js', async (c) => {
  try {
    const js = await readFileContent('frontend/init.js');
    return new Response(js, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache' },
    });
  } catch (error) {
    console.error('Error reading init.js:', error);
    return c.text('Not found', 404);
  }
});

// Removed legacy lorraine frontend

app.get('/frontend/mailcheckApp.js', async (c) => {
  try {
    const js = await readFileContent('frontend/mailcheckApp.js');
    return new Response(js, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache' },
    });
  } catch (error) {
    console.error('Error reading mailcheckApp.js:', error);
    return c.text('Not found', 404);
  }
});

// Academic email check (server-side; uses npm:academic-email-verifier)
// Removed standalone academic check endpoint; academic is part of /api/check/background

// Background check endpoint: runs sequential checkers server-side
app.post('/api/check/background', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body?.email || '').trim();
    const systemPrompt = typeof body?.systemPrompt === 'string' ? body.systemPrompt : '';
    const whitelist = Array.isArray(body?.whitelist) ? body.whitelist : [];
    const blacklist = Array.isArray(body?.blacklist) ? body.blacklist : [];
    const apiKey = serverApiKey || body?.userApiKey || Deno.env.get("GROQ_API_KEY");
    if (!apiKey) return c.json({ error: 'No Groq API key available.' }, 400);
    if (!email) return c.json({ error: 'email required' }, 400);
    const out = await backgroundAssessEmail(apiKey, email, systemPrompt, whitelist, blacklist);
    // try { console.log('>> [/api/check/background] result:', JSON.stringify(out)); } catch (_) {}
    return c.json(out);
  } catch (error) {
    console.error('background check error:', error);
    return c.json({ error: 'background check error: ' + error.message }, 500);
  }
});

// Async job APIs
// Create a job with one or more items. Body: { items: string[] | { email }[], systemPrompt?, concurrency?, userApiKey? }
app.post('/api/jobs', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    let items = Array.isArray(body?.items) ? body.items : [];
    const systemPrompt = typeof body?.systemPrompt === 'string' ? body.systemPrompt : '';
    const concurrency = Math.max(1, Number(body?.concurrency || 8) || 8);
    const apiKey = serverApiKey || body?.userApiKey || Deno.env.get("GROQ_API_KEY");
    if (!apiKey) return c.json({ error: 'No Groq API key available.' }, 400);
    // Normalize items to { id, email, status }
    items = items.map((v) => {
      const email = (v && typeof v === 'object') ? String(v.email || '').trim() : String(v || '').trim();
      return { id: generateId(), email, status: 'pending' };
    }).filter((it) => it.email);
    if (items.length === 0) return c.json({ error: 'no valid items' }, 400);
    const job = { id: generateId(), running: false, cancelled: false, total: 0, completed: 0, createdAt: nowTs(), updatedAt: nowTs(), items, systemPrompt };
    jobRegistry.set(job.id, job);
    // fire and forget
    runAsyncJob(job, apiKey, concurrency);
    return c.json(summarizeJob(job));
  } catch (error) {
    console.error('create job error:', error);
    return c.json({ error: 'create job error: ' + error.message }, 500);
  }
});

// Get job status by id
app.get('/api/jobs/:id', (c) => {
  try {
    const id = c.req.param('id');
    const job = id && jobRegistry.get(id);
    if (!job) return c.json({ error: 'not found' }, 404);
    return c.json(summarizeJob(job));
  } catch (error) {
    console.error('get job error:', error);
    return c.json({ error: 'get job error: ' + error.message }, 500);
  }
});

// Cancel a job by id
app.post('/api/jobs/:id/cancel', (c) => {
  try {
    const id = c.req.param('id');
    const job = id && jobRegistry.get(id);
    if (!job) return c.json({ error: 'not found' }, 404);
    job.cancelled = true;
    job.running = false;
    job.updatedAt = nowTs();
    return c.json(summarizeJob(job));
  } catch (error) {
    console.error('cancel job error:', error);
    return c.json({ error: 'cancel job error: ' + error.message }, 500);
  }
});

// LLM-based email legitimacy checker
// Asks the model to return JSON wrapped in <json>...</json> tags; retries with JSON modes if needed
// Removed standalone llm-email endpoint; compound is part of /api/check/background

export default (typeof Deno !== "undefined" && Deno.env.get("valtown")) ? app.fetch : app;