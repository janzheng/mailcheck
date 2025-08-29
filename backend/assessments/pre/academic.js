export async function preAcademicAssess(email) {
  const fields = {};
  try {
    const { Verifier } = await import('npm:academic-email-verifier');
    let isAcademic = false; let institution = null;
    try { isAcademic = await Verifier.isAcademic(email); } catch (_) { isAcademic = false; }
    try { institution = await Verifier.getInstitutionName(email); } catch (_) { institution = null; }
    const inst = typeof institution === 'string' ? institution.trim() : (institution ? String(institution) : null);
    fields.bg_academic = !!isAcademic; if (inst) fields.bg_institution = inst;
    if (isAcademic) fields.bg_academic_msg = inst || 'Academic domain';
  } catch (_) {}
  if (fields.bg_academic) {
    const inst = fields.bg_institution || '';
    const msg = inst ? ('Academic institution: ' + inst) : 'Academic domain';
    return {
      decided: true,
      status: 'academic',
      message: msg,
      fields,
      assessment: { name: 'academic', status: 'pass', message: msg }
    };
  }
  return null;
}


