import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/** TanStack Start's entry contract: the plugin imports `getRouter` by name. */
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register { router: ReturnType<typeof getRouter> }
}
