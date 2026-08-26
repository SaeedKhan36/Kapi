import { createFileRoute } from "@tanstack/react-router";
import { AuthPage } from "~/components/AuthPage.tsx";

export const Route = createFileRoute("/sign-in")({ component: () => <AuthPage mode="sign-in" /> });
