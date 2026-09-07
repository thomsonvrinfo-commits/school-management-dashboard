import React from 'react';
import Modal from '@/components/school/Modal';
import { useSchool } from '@/components/school/SchoolProvider';
import { average, percent, displayPercent } from '@/components/school/intelligence';
export default function AssessmentDetail({ assessment: a, onClose }) {
 const { data } = useSchool();
 return <Modal wide title={a.title} description={`${a.subject} · ${a.topic || 'General'} · ${a.date}`} onClose={onClose}><div className="rounded-lg bg-[#f0f4e9] p-4 text-xs leading-6">{data.classes.find(c => c.id === a.class_id)?.name} · {a.teacher || 'Teacher not recorded'}<br />{a.term} {a.academic_year} · {a.assessment_type || 'Assessment'}<br />Class average: <strong>{displayPercent(average(a.scores.map(s => percent(s.score, a.maximum))))}</strong> · {a.scores.length} results</div><table className="w-full text-left text-xs"><thead className="table-head"><tr><th className="p-3">Learner</th><th className="p-3">Score</th><th className="p-3">Percentage</th></tr></thead><tbody>{a.scores.map(s => <tr className="border-b" key={s.student_id}><td className="p-3">{data.students.find(v => v.id === s.student_id)?.name || 'Former student'}</td><td className="p-3">{s.score} / {a.maximum}</td><td className="p-3 font-semibold">{percent(s.score, a.maximum)}%</td></tr>)}</tbody></table></Modal>;
}