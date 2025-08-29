export function roleHeuristicAssess(email) {
  try {
    const local = String(email || '').split('@')[0].toLowerCase();
    const roleList = ['info', 'support', 'admin', 'sales', 'contact', 'hello', 'team', 'marketing', 'noreply', 'no-reply'];
    if (roleList.includes(local)) return { status: 'suspected_spam', message: 'Role-based address' };
  } catch (_) {}
  return {};
}


