import React, { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Menu, ChevronRight, CalendarDays, ShieldCheck } from 'lucide-react';
import SchoolProvider, { useSchool } from '@/components/school/SchoolProvider';
import Sidebar from '@/components/school/Sidebar';
import SchoolShell from '@/components/school/SchoolShell';
export default function SchoolLayout() { return <SchoolProvider><SchoolShell /></SchoolProvider>; }