import { useMemo } from 'react';

const BAR_COUNT = 22;

/**
 * Decorative waveform. It animates only while audio is actually playing so the
 * UI never claims to be playing something that is paused.
 */
export function Visualizer({ active }) {
  const bars = useMemo(
    () =>
      Array.from({ length: BAR_COUNT }, (_, index) => ({
        id: index,
        delay: `${(index % 7) * 0.11}s`,
        duration: `${0.85 + ((index * 37) % 60) / 100}s`,
      })),
    [],
  );

  return (
    <div className={`visualizer${active ? ' visualizer--active' : ''}`} aria-hidden="true">
      {bars.map((bar) => (
        <span
          key={bar.id}
          className="visualizer__bar"
          style={{
            animationDelay: bar.delay,
            animationDuration: bar.duration,
            transform: active ? undefined : `scaleY(${0.06 + ((bar.id * 13) % 9) / 40})`,
          }}
        />
      ))}
    </div>
  );
}
