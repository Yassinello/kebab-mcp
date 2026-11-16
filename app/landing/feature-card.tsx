interface FeatureCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
}

export default function FeatureCard({ title, description, icon }: FeatureCardProps) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 hover:border-slate-700 transition-colors">
      <div className="flex items-center gap-3 mb-2 lg:block">
        <div className="text-blue-400 lg:mb-3">{icon}</div>
        <h3 className="text-white font-semibold text-lg leading-snug lg:mb-2">{title}</h3>
      </div>
      <p className="text-slate-400 text-sm leading-relaxed">{description}</p>
    </div>
  );
}
