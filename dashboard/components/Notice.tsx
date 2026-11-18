// A one-line result banner after a form action. tone 'ok' or 'error'.
export default function Notice({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-live={tone === 'error' ? 'assertive' : 'polite'}>
      {children}
    </div>
  );
}
