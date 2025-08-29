// Shared assessment utilities

export function isEmailAddress(s) {
  const str = String(s || '').trim();
  if (!str) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str);
}

export function mergeSpamStatus(current, next) {
  if (!next) return current || undefined;
  if (!current) return next;
  const score = (s) => (s === 'likely_spam' ? 3 : s === 'suspected_spam' ? 2 : s === 'not_spam' ? 1 : 0);
  return score(next) >= score(current) ? next : current;
}

export function mergeStatus(current, next) {
  if (!next) return current || undefined;
  if (!current) return next;
  const score = (s) => (s === 'spam' ? 4 : s === 'person_none' ? 3 : s === 'person_low' ? 2 : s === 'person_high' ? 1 : 0);
  return score(next) >= score(current) ? next : current;
}

export function extractJsonBetweenTags(text) {
  try {
    if (!text) return null;
    const m = String(text).match(/<json>[\s\S]*?<\/json>/i);
    const slice = m ? m[0] : null;
    if (!slice) return null;
    const inner = slice.replace(/^<json>/i, '').replace(/<\/json>$/i, '');
    const trimmed = inner.trim();
    return JSON.parse(trimmed);
  } catch (err) {
    try { console.error('Failed to parse JSON between tags:', err && err.message ? err.message : String(err)); } catch (_) {}
    return null;
  }
}

export function logGroqCurl(tag, apiKey, payload) {
  try {
    const compact = JSON.stringify(payload);
    const esc = compact.replace(/'/g, `'"'"'`);
    const curl = [
      "curl --request POST \\\n",
      "    --url https://api.groq.com/openai/v1/chat/completions \\\n",
      "    --header 'authorization: Bearer " + apiKey + "' \\\n",
      "    --header 'content-type: application/json' \\\n",
      "    --data '" + esc + "'"
    ].join('');
    console.log(">> [" + tag + "] curl script:\n" + curl);
  } catch (_) {}
}

export function coerceJsonFromText(text) {
  try {
    if (!text) return null;
    const raw = String(text);
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = raw.slice(firstBrace, lastBrace + 1);
      try { return JSON.parse(candidate); } catch (_) {}
    }
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

export function getEmailDomain(address) {
  try { return String(address || '').split('@')[1]?.toLowerCase() || ''; } catch (_) { return ''; }
}

export function isGenericEmailDomain(domain) {
  const generic = new Set(['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','gmx.com','aol.com','proton.me','protonmail.com','mail.com','yandex.com']);
  return generic.has(String(domain || '').toLowerCase());
}

export function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of (arr || [])) { const v = String(s || '').trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}

export function statusToLabel(status) {
  if (status === 'spam') return 'spam';
  if (status === 'person_none') return 'no evidence';
  if (status === 'person_low') return 'possible person';
  if (status === 'likely_spam') return 'spam';
  if (status === 'suspected_spam') return 'suspicious';
  if (status === 'not_spam' || status === 'person_high') return 'likely real person';
  return String(status || '');
}

export function cleanDetailText(text) {
  try {
    if (!text) return '';
    let s = String(text);
    s = s.replace(/<tool>[\s\S]*?<\/tool>/gi, '').replace(/<output>[\s\S]*?<\/output>/gi, '');
    s = s.replace(/<json>[\s\S]*?<\/json>/gi, '');
    s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const paras = s.split(/\n\s*\n/).filter(p => p && p.trim());
    const limited = paras.slice(0, 3).map(p => p.trim().slice(0, 500));
    const joined = limited.join('\n\n').trim();
    return joined.slice(0, 1400);
  } catch (_) { return ''; }
}

export function deriveIdentityShort(explanation) {
  try {
    if (!explanation) return '';
    let s = String(explanation).trim();
    try {
      const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
      if (parts.length > 0) s = parts[0];
    } catch (_) {}
    if (s.length > 200) s = s.slice(0, 199).replace(/[,;:\s]+$/, '').trim() + '…';
    return s;
  } catch (_) { return ''; }
}


