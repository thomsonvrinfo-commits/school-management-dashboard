import React, { createContext, useContext, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { demoData, demoSchool } from '@/components/school/demoData';
const SchoolContext = createContext(null);
const entities = { classes: 'SchoolClass', students: 'Learner', assessments: 'SchoolAssessment', attendance: 'ClassAttendance', interventions: 'SupportIntervention' };
const empty = { classes: [], students: [], assessments: [], attendance: [], interventions: [] };
export default function SchoolProvider({ children }) {
  const { user } = useAuth(); const qc = useQueryClient();
  const [selected, setSelected] = useState(null); const [sample, setSample] = useState(demoData);
  const schoolsQuery = useQuery({ queryKey: ['schools', user.id], queryFn: () => base44.entities.School.filter({ created_by_id: user.id }, 'name', 100) });
  const schools = schoolsQuery.data || []; const school = schools.find(s => s.id === selected) || schools[0] || demoSchool; const isDemo = school.id === 'demo';
  const recordsQuery = useQuery({ queryKey: ['school-records', school.id, user.id], enabled: !isDemo, queryFn: async () => Object.fromEntries(await Promise.all(Object.entries(entities).map(async ([key, entity]) => [key, await base44.entities[entity].filter({ school_id: school.id, created_by_id: user.id }, '-created_date', 1000)]))) });
  const data = isDemo ? sample : recordsQuery.data || empty;
  async function save(key, values, id) {
    const { id: ignoredId, created_date, updated_date, created_by_id, created_by, ...fields } = values;
    const record = { ...fields, school_id: school.id };
    if (isDemo) { const result = { ...record, id: id || crypto.randomUUID() }; setSample(d => ({ ...d, [key]: id ? d[key].map(v => v.id === id ? { ...v, ...result } : v) : [...d[key], result] })); return result; }
    const result = id ? await base44.entities[entities[key]].update(id, record) : await base44.entities[entities[key]].create(record);
    await qc.invalidateQueries({ queryKey: ['school-records', school.id, user.id] }); return result;
  }
  async function saveSchool(values, id) {
    const result = id && id !== 'demo' ? await base44.entities.School.update(id, values) : await base44.entities.School.create(values);
    setSelected(result.id); await qc.invalidateQueries({ queryKey: ['schools', user.id] }); return result;
  }
  return <SchoolContext.Provider value={{ user, school, schools, setSelected, isDemo, data, save, saveSchool, loading: schoolsQuery.isPending || (!isDemo && recordsQuery.isPending), error: schoolsQuery.error || recordsQuery.error }}>{children}</SchoolContext.Provider>;
}
export const useSchool = () => useContext(SchoolContext);