import React from 'react';
import SchoolProvider from '@/components/school/SchoolProvider';
import SchoolShell from '@/components/school/SchoolShell';
export default function SchoolLayout() { return <SchoolProvider><SchoolShell /></SchoolProvider>; }