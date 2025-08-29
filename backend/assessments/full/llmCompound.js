import { groqChatCompletion } from '../../../chatCompletion.js';
import { extractJsonBetweenTags, cleanDetailText, deriveIdentityShort, statusToLabel } from '../utils.js';

export async function llmCompoundAssess(apiKey, email, systemPrompt) {
  const baseSystem = [
    'You assess whether an email belongs to a real person. Perform targeted web checks. If you cannot browse, reason only from public patterns in the address and provider; do not fabricate.',
    'Make an effort to look for identity signals on LinkedIn, company/staff pages, academic directories, GitHub, personal sites, press/newsroom/author pages, and social profiles.',
    'When identity is indicated, do light background digging: capture the person\'s name, role/title, organization, department/team, and location/city if available.',
    'Also look for negative signals: credible anti-abuse/anti-spam sources (e.g., StopForumSpam, Spamhaus, PhishTank), scam-reporting communities, or reputable media coverage indicating misuse. If credible negative signals exist, prefer status: spam.',
    'Return ONLY JSON wrapped in <json>...</json> tags using this schema:',
    '{ "status": "person_high|person_low|person_none|spam", "message": string, "explanation_short": string, "evidence": string[] }',
    'Guidelines:',
    '- person_high: strong identity signals clearly tie to the email/user (e.g., staff/author page, university/company directory, or a portfolio/personal site that credibly matches the individual).',
    '- person_low: requires at least one concrete, credible public signal about the person (e.g., portfolio/personal site with matching name/handle, staff/author/university/company page, or GitHub with substantive profile). Mere name-like matches or generic social profiles without a clear tie do NOT qualify.',
    '- person_none: choose this when there is no credible public identity evidence. Ambiguous name matches (e.g., multiple LinkedIn results for common names), generic provider emails with only a name-like local part, or signals that cannot be tied to the email/person should be person_none.',
    '- spam: obvious spam/role-based/throwaway patterns, or credible anti-spam sources flag the address.',
    '- Leniency: Only apply leniency toward person_low for non-generic organization or academic domains when there is at least one plausible institutional signal (e.g., being listed on an org/staff page). Do not apply leniency for generic providers or name-only signals.',
    '- Escalation: When you find a plausible identity match (person name plus role/title and/or organization/institution) from credible sources and there are no credible negative signals, prefer status: person_high, even if the address uses a generic email provider (e.g., gmail).',
    '- message: one short sentence preferring an identity-first summary, e.g., "Linked to Name — Title, Organization" when available. explanation_short: 2-3 sentences (<= 400 chars), plain text; no tool logs, URLs, or headings. If known, include person background (name, role/title, organization).',
    '- evidence: 1-5 short bullets summarizing concrete findings (no links). Include at least one background bullet when available (e.g., "Name — Title, Organization, City"). Include negative bullets when applicable (e.g., "Flagged on StopForumSpam" or "Reported in scam community"). If nothing credible is found, set evidence to [] and explicitly say "No public evidence found." and prefer status person_none.',
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
  const t1 = r1?.choices?.[0]?.message?.content || '';
  const reasoning1 = r1?.choices?.[0]?.message?.reasoning || '';
  let parsed = extractJsonBetweenTags(t1);
  if (!parsed) {
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
    const r2 = await groqChatCompletion(apiKey, payload2);
    try { parsed = JSON.parse(r2?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
    if (!parsed) {
      return {
        status: 'person_low',
        message: 'no compound signal',
        fields: { bg_compound_debug: (t1 || '').slice(0, 800), bg_llm_model: model }
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
    const label = statusToLabel(out.status || (parsed.status || 'person_low'));
    out.fields.bg_compound_label = label;
    out.fields.bg_compound_short = out.message || label;
    let detail = '';
    if (typeof parsed.explanation_short === 'string' && parsed.explanation_short.trim()) {
      detail = cleanDetailText(parsed.explanation_short);
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
    try {
      const shortPref = (typeof parsed.explanation_short === 'string' && parsed.explanation_short.trim()) ? deriveIdentityShort(parsed.explanation_short) : '';
      if (shortPref) out.fields.bg_compound_short = shortPref;
    } catch (_) {}
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


