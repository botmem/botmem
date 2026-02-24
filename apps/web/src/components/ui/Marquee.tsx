interface MarqueeProps {
  children: React.ReactNode;
}

export function Marquee({ children }: MarqueeProps) {
  return (
    <div className="border-3 border-nb-border bg-nb-yellow overflow-hidden">
      <div className="animate-marquee whitespace-nowrap py-2 px-4 font-mono text-sm font-bold uppercase text-black">
        <span className="inline-block">{children}</span>
        <span className="inline-block ml-24">{children}</span>
      </div>
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .animate-marquee {
          animation: marquee 20s linear infinite;
        }
      `}</style>
    </div>
  );
}
