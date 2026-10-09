import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { RequireAuth, RequireRole, homeFor } from "./components/shell.tsx";
import { authStore } from "./lib/auth.ts";
import { useStore } from "./lib/hooks.ts";
import { Account } from "./screens/account.tsx";
import { Login } from "./screens/login.tsx";
import { NotFound } from "./screens/not-found.tsx";
import { Overview } from "./screens/overview.tsx";
import { Register } from "./screens/register.tsx";
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
        <Route element={<RequireAuth />}>
          <Route index element={<Home />} />
          <Route path="today" element={<RequireRole role="teacher"><Today /></RequireRole>} />
          <Route path="classes/:classId/attendance" element={<RequireRole role="teacher"><Register /></RequireRole>} />
          <Route path="sync" element={<RequireRole role="teacher"><SyncPanel /></RequireRole>} />
          <Route path="overview" element={<RequireRole role="head"><Overview /></RequireRole>} />
          <Route path="account" element={<Account />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
