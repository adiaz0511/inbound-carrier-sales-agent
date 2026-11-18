export default function Loading() {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading dashboard data…</span>
      <div className="loading-head skeleton" />
      <div className="loading-grid" aria-hidden="true">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
      <div className="loading-table skeleton" aria-hidden="true" />
    </div>
  );
}
