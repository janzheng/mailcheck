import { getEmailDomain } from '../utils.js';

function isRegexToken(token) {
  try {
    const t = String(token || '');
    if (!t.startsWith('/')) return false;
    const last = t.lastIndexOf('/');
    return last > 0;
  } catch (_) { return false; }
}

function compileRegex(token) {
  try {
    const t = String(token || '');
    if (!isRegexToken(t)) return null;
    const last = t.lastIndexOf('/');
    const pattern = t.slice(1, last);
    const flags = t.slice(last + 1);
    return new RegExp(pattern, flags);
  } catch (_) { return null; }
}

function normalizeAllowlistTokens(list) {
  try {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const rawStr = String(raw || '').trim();
      if (!rawStr) continue;
      const t = isRegexToken(rawStr) ? rawStr : rawStr.toLowerCase();
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
    return d.endsWith('.' + t);
  } catch (_) { return false; }
}

function matchAllowlist(email, tokens) {
  try {
    const eRaw = String(email || '');
    const e = eRaw.toLowerCase();
    const domain = getEmailDomain(e);
    const list = normalizeAllowlistTokens(tokens);
    for (const t of list) {
      if (!t) continue;
      if (isRegexToken(t)) {
        const re = compileRegex(t);
        if (re) {
          try {
            re.lastIndex = 0; const matched = re.test(eRaw);
            try { console.log('>> [whitelist regex]', { rule: t, email: eRaw, matched }); } catch (_) {}
            if (matched) return t;
          } catch (_) {}
        }
        continue;
      }
      if (t.includes('@') && !t.includes('*')) {
        if (t.startsWith('@')) { if (domainMatches(t, domain)) return t; }
        else if (e === t) return t;
      } else if (t.startsWith('*@')) {
        if (domainMatches(t, domain)) return t;
      } else if (t.startsWith('@')) {
        if (domainMatches(t, domain)) return t;
      } else if (t.includes('.')) {
        if (domainMatches(t, domain)) return t;
      }
    }
    return null;
  } catch (_) { return null; }
}

export function preAllowlistAssess(email, allowlistRules) {
  try {
    const matched = matchAllowlist(email, allowlistRules);
    if (!matched) return { message: 'no match' };
    const fields = { bg_allowlist_rule: matched, bg_allowlist_msg: 'Allowlisted' };
    return {
      decided: true,
      status: 'whitelist',
      message: 'Allowlisted via ' + matched,
      fields,
      assessment: { name: 'allowlist', status: 'pass', message: 'matched ' + matched }
    };
  } catch (_) { return null; }
}


