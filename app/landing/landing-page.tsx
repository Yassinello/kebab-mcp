import LandingHeader from "./header";
import Hero from "./hero";
import WhyKebab from "./why-kebab";
import HowItWorks from "./how-it-works";
import Connectors from "./connectors";
import Compatibility from "./compatibility";
import Trust from "./trust";
import CtaSection from "./cta-section";
import LandingFooter from "./footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <LandingHeader />
      <main>
        <Hero />
        <WhyKebab />
        <HowItWorks />
        <Connectors />
        <Compatibility />
        <Trust />
        <CtaSection />
      </main>
      <LandingFooter />
    </div>
  );
}
