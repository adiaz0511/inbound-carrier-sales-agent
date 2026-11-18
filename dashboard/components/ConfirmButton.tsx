'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

type Props = {
  children: ReactNode;
  formAction: (formData: FormData) => void | Promise<void>;
  className?: string;
  // Native confirm() text. The browser's own required-field checks run first, so the question is only asked for a valid form.
  confirmMessage?: string;
  // Field names that must be filled before the action is sent (checked in the browser; the server checks again).
  requiredFields?: string[];
  disabled?: boolean;
};

export default function ConfirmButton({ children, formAction, className, confirmMessage, requiredFields = [], disabled = false }: Props) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={formAction}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending}
      onClick={(e) => {
        const form = e.currentTarget.form;
        if (!form) return;
        for (const name of requiredFields) {
          const field = form.elements.namedItem(name);
          if (field instanceof HTMLInputElement && field.value.trim() === '') {
            e.preventDefault();
            field.setCustomValidity('Enter a reason before releasing this hold.');
            field.reportValidity();
            field.addEventListener('input', () => field.setCustomValidity(''), { once: true });
            return;
          }
        }
        if (!form.reportValidity()) {
          e.preventDefault();
          return;
        }
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}
