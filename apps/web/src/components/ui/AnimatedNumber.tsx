import { useEffect, useRef, useState } from 'react';
import { formatCompactNumber } from '../../lib/formatNumber';

interface AnimatedNumberProps {
  value: number | string | null | undefined;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function AnimatedNumber({ value, duration = 600, className, style }: AnimatedNumberProps) {
  const numericValue = typeof value === 'string' ? Number(value) : value;
  const safeValue =
    typeof numericValue === 'number' && Number.isFinite(numericValue) ? numericValue : 0;
  const [display, setDisplay] = useState(safeValue);
  const prevRef = useRef(safeValue);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = prevRef.current;
    const to = safeValue;
    prevRef.current = safeValue;

    if (from === to) {
      setDisplay(to);
      return;
    }

    const start = performance.now();
    const diff = to - from;

    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + diff * eased));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [safeValue, duration]);

  return (
    <span className={className} style={style}>
      {formatCompactNumber(display)}
    </span>
  );
}
