import { createFileRoute } from "@tanstack/react-router";
import {
  CallToAction, Capabilities, Hero, HowItWorks, MarketingFooter, MarketingNav, ProductShowcase,
} from "~/components/landing/Sections.tsx";
import { useReveal } from "~/lib/useReveal.ts";

/** What kapi is, for someone who has not seen it before. */
export const Route = createFileRoute("/")({ component: Landing });

function Landing() {
  useReveal();

  return (
    <div className="landing min-h-screen">
      <MarketingNav />
      <main>
        <Hero />
        <HowItWorks />
        <ProductShowcase />
        <Capabilities />
        <CallToAction />
      </main>
      <MarketingFooter />
    </div>
  );
}
