import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RequireAuth } from "~/components/auth.tsx";

/** Everything under /app needs a session; the gate lives here, once. */
export const Route = createFileRoute("/app")({ component: AppLayout });

function AppLayout() {
  return (
    <RequireAuth>
      <Outlet />
    </RequireAuth>
  );
}
