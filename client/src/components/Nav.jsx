import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from './Aurora.jsx';

export function Nav({ children, onBrandClick }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`nav${scrolled ? ' nav--scrolled' : ''}`}>
      <div className="nav__inner">
        <Link to="/" className="brand" onClick={onBrandClick}>
          <BrandMark />
          <span className="brand__text">
            Sync<b>Audio</b>
          </span>
        </Link>
        <span className="spacer" />
        {children}
      </div>
    </header>
  );
}
