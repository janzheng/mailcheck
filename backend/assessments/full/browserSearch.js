import { groqChatCompletion } from '../../../chatCompletion.js';
import { statusToLabel, deriveIdentityShort, coerceJsonFromText, logGroqCurl } from '../utils.js';

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

export async function browserSearchAssess(apiKey, email, systemPrompt) {
  const baseSystem = [
    'Use web browsing to gather public signals about whether this email belongs to a real person; do not fabricate.',
    'Call browser_search with multiple targeted queries. Try: the full email in quotes; the local part and domain; site:linkedin.com with likely name/handle; site:github.com with the handle; university/staff directories; newsroom/author pages; personal sites; press pages.',
    'Prefer authoritative sources: LinkedIn, staff/author/company pages, academic directories, GitHub, reputable media. Also check credible anti-abuse/anti-spam sources (StopForumSpam, Spamhaus, PhishTank) and scam-reporting communities. Avoid data brokers and spammy aggregators.',
    'When identity is indicated, do light background digging: capture the person\'s name, role/title, organization, department/team, and location/city if available.',
    'Leniency rule: Only apply leniency toward person_low for non-generic organization or academic domains when there is at least one plausible institutional signal (e.g., listed on org/staff page or directory). Do not apply leniency for generic providers or name-only matches.',
    'Escalation rule: If you find a plausible identity match (person name plus role/title and/or organization/institution) from credible sources and no credible negative signals, prefer Status: person_high, even when the address uses a generic provider (e.g., gmail).',
    'Produce a concise plain-text analysis with the following sections only (do not include any JSON):',
    'Status: one of person_high | person_low | person_none | spam',
    'Message: one short sentence preferring an identity-first summary, e.g., "Linked to Name — Title, Organization" when available',
    'Explanation: 2-3 sentences (<= 400 chars), reference evidence or say No public evidence found. If known, include person background (name, role/title, organization).',
    'Evidence: 1-5 short bullet points summarizing concrete findings (no links). Include at least one bullet with person background when available (e.g., "Name — Title, Organization, City"). Include negative bullets such as "Flagged on StopForumSpam" or "Mentioned in scam-reporting community" when applicable. If nothing credible found, leave this section empty and prefer Status: person_none.',
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
  const t1 = r1?.choices?.[0]?.message?.content || '';
  const out = { fields: { bg_browser_model: model } };
  let parsed = await convertAnalysisToJson(apiKey, email, t1);
  if (!parsed) parsed = coerceJsonFromText(t1);
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


