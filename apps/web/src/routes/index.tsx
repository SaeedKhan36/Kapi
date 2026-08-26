import { createFileRoute } from "@tanstack/react-router";
import {
  ArchitectureSection, CallToAction, Capabilities, Faq, Hero, HowItWorks,
  MarketingFooter, MarketingNav, Pricing, StatStrip,
} from "~/components/landing/Sections.tsx";
import { useReveal } from "~/lib/useReveal.ts";

/** What kapi is, for someone who has not seen it before. */
export const Route = createFileRoute("/")({ component: Landing });

function Landing() {
  useReveal();

  return (
    <div className="min-h-screen">
      <MarketingNav />
      <main>
        <Hero />
        <StatStrip />
        <HowItWorks />
        <div className="shell"><div className="rule" /></div>
        <Capabilities />
        <ArchitectureSection />
        <Pricing />
        <Faq />
        <CallToAction />
      </main>
      <MarketingFooter />
    </div>
  );
}
