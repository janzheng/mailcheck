// Central aggregator for assessments
// Exposes a single backgroundAssessEmail() used by API routes

import { isEmailAddress as uIsEmailAddress, mergeSpamStatus as uMergeSpamStatus, getEmailDomain as uGetEmailDomain, isGenericEmailDomain as uIsGenericEmailDomain, dedupeStrings as uDedupeStrings, statusToLabel as uStatusToLabel } from './utils.js';
import { preAllowlistAssess as modPreAllowlistAssess } from './pre/allowlist.js';
import { preAcademicAssess as modPreAcademicAssess } from './pre/academic.js';
import { preBlocklistAssess as modPreBlocklistAssess } from './pre/blocklist.js';
import { roleHeuristicAssess as modRoleHeuristicAssess } from './full/roleHeuristic.js';
import { llmCompoundAssess as modLlmCompoundAssess } from './full/llmCompound.js';
import { browserSearchAssess as modBrowserSearchAssess } from './full/browserSearch.js';
import { finalJudgeAssess as modFinalJudgeAssess } from './full/finalJudge.js';

export async function backgroundAssessEmail(apiKey, email, systemPrompt, allowlistRules, blocklistRules) {
  let status = undefined; const messages = []; const fields = {};
  const assessments = [];
  if (!uIsEmailAddress(email)) { status = 'spam'; messages.push('Invalid email format'); }

  // Pre-assessments (early exits)
  try { console.log('>> [pre] starting', { email, allowlistCount: Array.isArray(allowlistRules) ? allowlistRules.length : 0, blocklistCount: Array.isArray(blocklistRules) ? blocklistRules.length : 0 }); } catch (_) {}
  const preAssessors = [
    { name: 'allowlist', run: () => modPreAllowlistAssess(email, allowlistRules) },
    { name: 'academic', run: () => modPreAcademicAssess(email) },
    { name: 'blocklist', run: () => modPreBlocklistAssess(email, blocklistRules) },
  ];
  for (const pre of preAssessors) {
    try {
      const r = await pre.run();
      try { console.log('>> [pre] result', pre.name, r); } catch (_) {}
      if (r && r.decided) {
        if (r.fields) Object.assign(fields, r.fields);
        if (r.assessment) assessments.push(r.assessment);
        // Include role heuristic quick flag for scanning
        const roleQuick = modRoleHeuristicAssess(email);
        if (roleQuick && roleQuick.message) { fields.bg_role = true; fields.bg_role_msg = roleQuick.message; }
        else { fields.bg_role = false; }
        // Build standardized one-liner outputs for all assessors (marking not-run assessors explicitly)
        const toHuman = (s) => (s === 'person_high' ? 'likely human' : s === 'person_low' ? 'possible human' : s === 'person_none' ? 'no evidence' : s === 'spam' ? 'spam' : String(s || ''));
        const lines = [];
        // allowlist / blocklist
        lines.push('allowlist: ' + (fields.bg_allowlist_rule ? 'allowed' : 'not listed'));
        lines.push('blocklist: ' + (fields.bg_blocklist_rule ? 'blocked' : 'not blocked'));
        // academic
        lines.push('academic: ' + (fields.bg_academic ? (fields.bg_institution ? fields.bg_institution : 'academic') : 'not academic'));
        // role
        lines.push('role: ' + (fields.bg_role ? (fields.bg_role_msg || 'role-based') : 'clean'));
        // browser / llm not run due to early exit
        lines.push('browser: not run');
        lines.push('llm: not run');
        // final maps to decided status
        lines.push('final: ' + toHuman(r.status));
        fields.bg_assessor_lines = lines;
        fields.bg_assessments = assessments;
        return { email, status: r.status, message: r.message || '', fields, assessments };
      } else {
        // Even if not decided, add assessment for tracking
        assessments.push({ name: pre.name, status: null, message: r?.message || 'no match' });
      }
    } catch (_) {
      assessments.push({ name: pre.name, status: null, message: 'error' });
    }
  }

  const role = modRoleHeuristicAssess(email);
  if (role.status) status = uMergeSpamStatus(status, role.status);
  if (role.message) messages.push(role.message);
  if (role && role.message) { fields.bg_role = true; fields.bg_role_msg = role.message; }
  else { fields.bg_role = false; }

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
    // Build standardized one-liner outputs for scanning
    const toHuman = (s) => (s === 'person_high' ? 'likely human' : s === 'person_low' ? 'possible human' : s === 'person_none' ? 'no evidence' : s === 'spam' ? 'spam' : String(s || ''));
    const lines = [];
    lines.push('allowlist: ' + (fields.bg_allowlist_rule ? 'allowed' : 'not listed'));
    lines.push('blocklist: ' + (fields.bg_blocklist_rule ? 'blocked' : 'not blocked'));
    lines.push('academic: ' + (fields.bg_academic ? (fields.bg_institution ? fields.bg_institution : 'academic') : 'not academic'));
    lines.push('role: ' + (fields.bg_role ? (fields.bg_role_msg || 'role-based') : 'clean'));
    lines.push('browser: ' + (browse && browse.status ? toHuman(browse.status) : (fields.bg_browser_label ? String(fields.bg_browser_label) : 'not run')));
    lines.push('llm: ' + (llm && llm.status ? toHuman(llm.status) : (fields.bg_compound_label ? String(fields.bg_compound_label) : 'not run')));
    lines.push('final: ' + toHuman(status));
    fields.bg_assessor_lines = lines;
    // Ensure all assessors have entries in the assessments array
    const assessorNames = ['allowlist', 'academic', 'blocklist', 'role_heuristic', 'compound', 'browser', 'final_judge'];
    for (const name of assessorNames) {
      const existing = assessments.find(a => a.name === name);
      if (!existing) {
        let message = 'not run';
        let status = null;
        if (name === 'allowlist') message = fields.bg_allowlist_rule ? 'allowed' : 'no match';
        else if (name === 'blocklist') message = fields.bg_blocklist_rule ? 'blocked' : 'no match';
        else if (name === 'academic') message = fields.bg_academic ? 'academic' : 'no match';
        else if (name === 'role_heuristic') message = fields.bg_role ? (fields.bg_role_msg || 'role-based') : 'clean';
        assessments.push({ name, status, message });
      }
    }
  } catch (err) {
    try { console.error('>> [compound] error:', err && err.message ? err.message : String(err)); } catch (_) {}
    fields.bg_compound_debug = err && err.message ? err.message : String(err);
  }
  if (!status) status = 'person_low';
  fields.bg_assessments = assessments;
  return { email, status, message: messages.join('; '), fields, assessments };
}


