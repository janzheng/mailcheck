// Central aggregator for assessments
// Exposes a single backgroundAssessEmail() used by API routes

import { isEmailAddress as uIsEmailAddress, mergeSpamStatus as uMergeSpamStatus, getEmailDomain as uGetEmailDomain, isGenericEmailDomain as uIsGenericEmailDomain, dedupeStrings as uDedupeStrings, statusToLabel as uStatusToLabel } from './utils.js';
import { preWhitelistAssess as modPreWhitelistAssess } from './pre/whitelist.js';
import { preAcademicAssess as modPreAcademicAssess } from './pre/academic.js';
import { preBlacklistAssess as modPreBlacklistAssess } from './pre/blacklist.js';
import { roleHeuristicAssess as modRoleHeuristicAssess } from './full/roleHeuristic.js';
import { llmCompoundAssess as modLlmCompoundAssess } from './full/llmCompound.js';
import { browserSearchAssess as modBrowserSearchAssess } from './full/browserSearch.js';
import { finalJudgeAssess as modFinalJudgeAssess } from './full/finalJudge.js';

export async function backgroundAssessEmail(apiKey, email, systemPrompt, whitelistRules, blacklistRules) {
  let status = undefined; const messages = []; const fields = {};
  const assessments = [];
  if (!uIsEmailAddress(email)) { status = 'spam'; messages.push('Invalid email format'); }

  // Pre-assessments (early exits)
  try { console.log('>> [pre] starting', { email, whitelistCount: Array.isArray(whitelistRules) ? whitelistRules.length : 0, blacklistCount: Array.isArray(blacklistRules) ? blacklistRules.length : 0 }); } catch (_) {}
  const preAssessors = [
    { name: 'whitelist', run: () => modPreWhitelistAssess(email, whitelistRules) },
    { name: 'academic', run: () => modPreAcademicAssess(email) },
    { name: 'blacklist', run: () => modPreBlacklistAssess(email, blacklistRules) },
  ];
  for (const pre of preAssessors) {
    try {
      const r = await pre.run();
      try { console.log('>> [pre] result', pre.name, r); } catch (_) {}
      if (r && r.decided) {
        if (r.fields) Object.assign(fields, r.fields);
        if (r.assessment) assessments.push(r.assessment);
        fields.bg_assessments = assessments;
        return { email, status: r.status, message: r.message || '', fields, assessments };
      }
    } catch (_) {}
  }

  const role = modRoleHeuristicAssess(email);
  if (role.status) status = uMergeSpamStatus(status, role.status);
  if (role.message) messages.push(role.message);

  try {
    let llm = null; let browse = null;
    const [llmRes, browseRes] = await Promise.allSettled([
      modLlmCompoundAssess(apiKey, email, systemPrompt),
      modBrowserSearchAssess(apiKey, email, systemPrompt)
    ]);
    if (llmRes.status === 'fulfilled') {
      llm = llmRes.value;
      if (llm) {
        if (llm.status) status = uMergeSpamStatus(status, llm.status);
        if (llm.message) fields.bg_compound_msg = llm.message;
        if (llm.status) fields.bg_compound_label = uStatusToLabel(llm.status);
        if (!fields.bg_compound_short && llm.message) fields.bg_compound_short = llm.message;
        if (llm.fields) Object.assign(fields, llm.fields);
        assessments.push({ name: 'compound', status: llm.status || null, message: llm.message || null });
      }
    } else {
      try { console.error('>> [compound] error:', llmRes.reason && llmRes.reason.message ? llmRes.reason.message : String(llmRes.reason)); } catch (_) {}
      fields.bg_compound_debug = llmRes.reason && llmRes.reason.message ? llmRes.reason.message : String(llmRes.reason);
    }
    if (browseRes.status === 'fulfilled') {
      browse = browseRes.value;
      if (browse) {
        if (browse.status) status = uMergeSpamStatus(status, browse.status);
        if (browse.message) fields.bg_browser_msg = browse.message;
        if (!fields.bg_browser_short && browse.message) fields.bg_browser_short = browse.message;
        if (browse.fields) Object.assign(fields, browse.fields);
        assessments.push({ name: 'browser', status: browse.status || null, message: browse.message || null });
      }
    } else {
      try { console.error('>> [browser] error:', browseRes.reason && browseRes.reason.message ? browseRes.reason.message : String(browseRes.reason)); } catch (_) {}
      fields.bg_browser_debug = browseRes.reason && browseRes.reason.message ? browseRes.reason.message : String(browseRes.reason);
    }

    // Final judge
    const d = uGetEmailDomain(email);
    const evidence = {
      academic: { academic: !!fields.bg_academic, institution: fields.bg_institution || null },
      role: { message: role.message || null, status: role.status || null },
      domain: { domain: d || null, generic_provider: d ? uIsGenericEmailDomain(d) : null },
      compound: { status: llm?.status || null, message: llm?.message || null, short: fields.bg_compound_short || null, label: fields.bg_compound_label || null, evidence: Array.isArray(fields.bg_compound_evidence) ? fields.bg_compound_evidence : [] },
      browser: { status: browse?.status || null, message: browse?.message || null, short: fields.bg_browser_short || null, label: fields.bg_browser_label || null, evidence: Array.isArray(fields.bg_browser_evidence) ? fields.bg_browser_evidence : [] }
    };
    try { console.log('>> [final judge] evidence:', JSON.stringify(evidence)); } catch (_) {}
    const judge = await modFinalJudgeAssess(apiKey, email, systemPrompt, evidence);
    if (judge) {
      if (judge.status) status = judge.status;
      if (judge.message && !fields.bg_final_short) fields.bg_final_short = judge.message;
      if (judge.fields) Object.assign(fields, judge.fields);
      assessments.push({ name: 'final_judge', status: judge.status || null, message: judge.message || null });
    }
    try { console.log('>> [final judge] judge:', JSON.stringify(judge)); } catch (_) {}

    // Consolidate evidence bullets and UI detail if missing
    const allEvidence = [];
    if (Array.isArray(fields.bg_final_evidence)) allEvidence.push(...fields.bg_final_evidence);
    if (Array.isArray(fields.bg_browser_evidence)) allEvidence.push(...fields.bg_browser_evidence);
    if (Array.isArray(fields.bg_compound_evidence)) allEvidence.push(...fields.bg_compound_evidence);
    const domain = uGetEmailDomain(email);
    if (fields.bg_academic && fields.bg_institution) allEvidence.push('Academic institution: ' + fields.bg_institution);
    if (domain) {
      if (uIsGenericEmailDomain(domain)) allEvidence.push('Generic email provider: ' + domain); else allEvidence.push('Organization domain detected: ' + domain);
    }
    if (role && role.message) allEvidence.push(role.message);
    const deduped = uDedupeStrings(allEvidence).slice(0, 8);
    if (!fields.bg_final_evidence) fields.bg_final_evidence = deduped.length > 0 ? deduped : ['No public evidence found'];
    if (!fields.bg_final_detail) {
      const parts = [];
      if (fields.bg_academic && fields.bg_institution) parts.push('Academic institution: ' + fields.bg_institution + '.');
      else if (domain) parts.push(uIsGenericEmailDomain(domain) ? ('Generic provider: ' + domain + '.') : ('Organization domain: ' + domain + '.'));
      if (judge && judge.message) parts.push(judge.message);
      const fallback = parts.join(' ').trim();
      fields.bg_final_detail = fallback || 'No public evidence found.';
    }
  } catch (err) {
    try { console.error('>> [compound] error:', err && err.message ? err.message : String(err)); } catch (_) {}
    fields.bg_compound_debug = err && err.message ? err.message : String(err);
  }
  if (!status) status = 'person_low';
  fields.bg_assessments = assessments;
  return { email, status, message: messages.join('; '), fields, assessments };
}


