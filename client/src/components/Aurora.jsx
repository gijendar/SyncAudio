import { AudioLines } from 'lucide-react';

/** Subtle animated gradient backdrop. Purely decorative. */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="aurora__blob aurora__blob--1" />
      <div className="aurora__blob aurora__blob--2" />
      <div className="aurora__blob aurora__blob--3" />
      <div className="aurora__grid" />
    </div>
  );
}

export function BrandMark() {
  return (
    <span className="brand__mark">
      <AudioLines aria-hidden="true" />
    </span>
  );
}
