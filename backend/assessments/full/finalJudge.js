import { groqChatCompletion } from '../../../chatCompletion.js';
import { statusToLabel, deriveIdentityShort } from '../utils.js';

export async function finalJudgeAssess(apiKey, email, systemPrompt, evidence) {
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
    '- Leniency: Only apply leniency toward person_low for non-generic organization or academic domains when at least one institutional or portfolio-like signal exists (e.g., org/staff page, university directory, personal site with substantive details). Do not apply leniency for generic providers or name-only matches.',
    '- Escalation: If there is a plausible identity match (person name plus role/title and/or organization/institution) from credible sources and no credible negative signals, prefer person_high even if the address uses a generic provider (e.g., gmail).',
    '- If no credible public evidence is present, set evidence to [] and explicitly say "No public evidence found." in explanation_short and prefer status: person_none.',
    '- message must be one short, specific sentence preferring an identity-first summary like "Linked to Name — Title, Organization" when available. explanation_short must be 2-3 sentences (<= 400 chars) and reference key evidence or lack thereof. If known, weave in person background (name, role/title, organization).',
    '- Note recognizable roles when present (reporter, journalist, professor, founder, recruiter).'
  ].join('\n');
  const user = [ 'Email: ' + email, 'Evidence (JSON):', JSON.stringify(evidence) ].join('\n');
  const judgePayload = { model, messages: [ { role: 'system', content: sys + (systemPrompt ? ('\nExtra: ' + systemPrompt) : '') }, { role: 'user', content: user } ], stream: false, temperature: 0.2, response_format: { type: 'json_object' } };
  const r = await groqChatCompletion(apiKey, judgePayload);
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


