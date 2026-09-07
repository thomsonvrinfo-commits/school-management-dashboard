export const average = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
export const percent = (score, max) => max > 0 ? Math.round(score / max * 100) : null;
export const displayPercent = value => value == null ? '—' : `${value}%`;
export function resultsFor(studentId, assessments) {
  return assessments.flatMap(a => (a.scores || []).filter(s => s.student_id === studentId).map(s => ({ ...a, score: s.score, percentage: percent(s.score, a.maximum), classAverage: average((a.scores || []).map(v => percent(v.score, a.maximum))) }))).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
export function learnerInsight(student, data) {
  const results = resultsFor(student.id, data.assessments);
  const latest = results.at(-1);
  const comparable = latest ? results.filter(r => r.subject === latest.subject && r.class_id === latest.class_id) : [];
  const previous = comparable.at(-2);
  const change = previous && latest ? latest.percentage - previous.percentage : null;
  const active = data.interventions.some(i => i.student_id === student.id && i.status === 'Active');
  const state = !latest ? 'No results' : active ? 'Intervention active' : latest.percentage < 50 ? 'Attention required' : change <= -10 ? 'Declining' : change >= 5 ? 'Improving' : latest.percentage < 60 ? 'Monitor' : 'On track';
  return { ...student, results, latest, change, state, average: average(results.map(r => r.percentage)), needsAttention: latest && (latest.percentage < 50 || change <= -10), evidence: latest ? `${latest.title} · ${latest.date}: ${latest.score}/${latest.maximum} (${latest.percentage}%). Class average ${latest.classAverage}%.${previous ? ` Previous ${latest.subject} result: ${previous.percentage}%.` : ''}` : 'No assessment evidence yet.' };
}
export function attendanceRate(records) {
  const entries = records.flatMap(r => r.entries || []);
  return entries.length ? Math.round(entries.filter(e => ['Present', 'Late'].includes(e.status)).length / entries.length * 100) : null;
}
export function exportCsv(name, rows) {
  const cell = v => '"' + String(v ?? '').replace(/^[=+@\-]/, "'$&").replaceAll('"', '""') + '"';
  const blob = new Blob(['\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name + '.csv'; link.click(); URL.revokeObjectURL(url);
}