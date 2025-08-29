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

function normalizeBlacklistTokens(list) {
  try {
    const input = Array.isArray(list) ? list : [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
      const rawStr = String(raw || '').trim();
      if (!rawStr) continue;
      const t = isRegexToken(rawStr) ? rawStr : rawStr.toLowerCase();
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
    // If token includes a dot, require suffix match like sub.domain.tld
    if (t.includes('.')) return d.endsWith('.' + t);
    // If token has no dot (e.g., "noidem"), match against any domain label
    const labels = d.split('.');
    return labels.includes(t);
  } catch (_) { return false; }
}

function matchBlacklist(email, tokens) {
  try {
    const eRaw = String(email || '');
    const e = eRaw.toLowerCase();
    const local = eRaw.split('@')[0] || '';
    const domain = getEmailDomain(e);
    const list = normalizeBlacklistTokens(tokens);
    try { console.log('>> [blacklist] normalized list', list); } catch (_) {}
    for (const t of list) {
      if (!t) continue;
      try { console.log('>> [blacklist] processing token', t, 'isRegex:', isRegexToken(t)); } catch (_) {}
      // Regex rule
      if (isRegexToken(t)) {
        const re = compileRegex(t);
        if (re) {
          try {
            let matched = false; let target = '';
            // reset lastIndex for safety in case of /g
            re.lastIndex = 0; if (!matched && re.test(eRaw)) { matched = true; target = 'raw'; }
            re.lastIndex = 0; if (!matched && re.test(e)) { matched = true; target = 'lower'; }
            if (!matched && local) {
              re.lastIndex = 0; if (re.test(local + '@')) { matched = true; target = 'local@'; }
              if (!matched) { re.lastIndex = 0; if (re.test((local.toLowerCase()) + '@')) { matched = true; target = 'local@-lower'; } }
            }
            try { console.log('>> [blacklist regex]', { rule: t, email: eRaw, matched, target }); } catch (_) {}
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

export function preBlacklistAssess(email, blacklistRules) {
  try {
    try { console.log('>> [blacklist] called with', { email, rules: blacklistRules }); } catch (_) {}
    const matched = matchBlacklist(email, blacklistRules);
    try { console.log('>> [blacklist] match result', matched); } catch (_) {}
    if (!matched) return null;
    const fields = { bg_blacklist_rule: matched, bg_blacklist_msg: 'Blacklisted', bg_blacklist: true };
    return {
      decided: true,
      status: 'spam',
      message: 'Blacklisted via ' + matched,
      fields,
      assessment: { name: 'blacklist', status: 'fail', message: 'matched ' + matched }
    };
  } catch (_) { return null; }
}



