import LandingHeader from "./header";
import Hero from "./hero";
import Audience from "./audience";
import WhyKebab from "./why-kebab";
import HowItWorks from "./how-it-works";
import Product from "./product";
import Connectors from "./connectors";
import Compatibility from "./compatibility";
import Guardrails from "./guardrails";
import Faq from "./faq";
import CtaSection from "./cta-section";
import LandingFooter from "./footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <LandingHeader />
      <main>
        <Hero />
        <Audience />
        <WhyKebab />
        <HowItWorks />
        <Compatibility />
        <Product />
        <Connectors />
        <Guardrails />
        <Faq />
        <CtaSection />
      </main>
      <LandingFooter />
    </div>
  );
}
