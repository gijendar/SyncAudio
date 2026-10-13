import { useEffect } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, subtitle, onClose, children, labelledBy = 'modal-title' }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className="modal">
        <div className="modal__head">
          <div>
            <h2 className="modal__title" id={labelledBy}>
              {title}
            </h2>
            {subtitle ? <p className="modal__sub">{subtitle}</p> : null}
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
