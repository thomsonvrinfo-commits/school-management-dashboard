import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { RequireAuth, RequireRole, homeFor } from "./components/shell.tsx";
import { authStore } from "./lib/auth.ts";
import { useStore } from "./lib/hooks.ts";
import { Account } from "./screens/account.tsx";
import { AcceptInvitation } from "./screens/accept.tsx";
import { ClassCreate, ClassDetailScreen, ClassList } from "./screens/admin/classes.tsx";
import { SchoolSettings } from "./screens/admin/school.tsx";
import { StaffScreen } from "./screens/admin/staff.tsx";
import { StudentCreate, StudentDetailScreen, StudentList } from "./screens/admin/students.tsx";
import { Login } from "./screens/login.tsx";
import { NotFound } from "./screens/not-found.tsx";
import { Overview } from "./screens/overview.tsx";
import { Register } from "./screens/register.tsx";
import { ResetPassword } from "./screens/reset.tsx";
import { SyncPanel } from "./screens/sync-panel.tsx";
import { Today } from "./screens/today.tsx";

function Home() {
  const auth = useStore(authStore);
  return auth.status === "signedIn" ? <Navigate to={homeFor(auth.me.role)} replace /> : null;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* P1: reached from a link, signed in or not; the secret is in the part after "#" and never reaches the server */}
        <Route path="/accept" element={<AcceptInvitation />} />
        <Route path="/reset" element={<ResetPassword />} />
        <Route element={<RequireAuth />}>
          <Route index element={<Home />} />
          <Route path="today" element={<RequireRole role="teacher"><Today /></RequireRole>} />
          <Route path="classes/:classId/attendance" element={<RequireRole role="teacher"><Register /></RequireRole>} />
          <Route path="sync" element={<RequireRole role="teacher"><SyncPanel /></RequireRole>} />
          <Route path="overview" element={<RequireRole role="head"><Overview /></RequireRole>} />
          {/* Slice 2: school administration (head only; the API enforces the same rule) */}
          <Route path="school" element={<RequireRole role="head"><SchoolSettings /></RequireRole>} />
          <Route path="staff" element={<RequireRole role="head"><StaffScreen /></RequireRole>} />
          <Route path="students" element={<RequireRole role="head"><StudentList /></RequireRole>} />
          <Route path="students/new" element={<RequireRole role="head"><StudentCreate /></RequireRole>} />
          <Route path="students/:id" element={<RequireRole role="head"><StudentDetailScreen /></RequireRole>} />
          <Route path="classes" element={<RequireRole role="head"><ClassList /></RequireRole>} />
          <Route path="classes/new" element={<RequireRole role="head"><ClassCreate /></RequireRole>} />
          <Route path="classes/:id" element={<RequireRole role="head"><ClassDetailScreen /></RequireRole>} />
          <Route path="account" element={<Account />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
