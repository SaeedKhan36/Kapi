import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Spinner } from "~/components/ui.tsx";

/**
 * Where WorkOS sends the browser back to.
 *
 * AuthKit's client exchanges the code itself as soon as it loads on this URL,
 * so there is nothing to do here but wait for the session to settle and get
 * out of the way. The redirect is unconditional: staying on /callback with a
 * code still in the address bar invites a refresh that replays it.
 */
export const Route = createFileRoute("/callback")({ component: Callback });

function Callback() {
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => navigate({ to: "/", replace: true }), 400);
    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <div className="grid place-items-center py-24 text-muted">
      <Spinner />
      <p className="mt-3 text-sm">Signing you in…</p>
    </div>
  );
}
