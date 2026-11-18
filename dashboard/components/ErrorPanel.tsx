// Friendly error for a failed data request. Never shows internal codes or service names.
export default function ErrorPanel({}: { error: unknown }) {
  return (
    <div className="panel error" role="alert">
      <h2>Couldn&apos;t load data</h2>
      <p>Refresh in a minute. The data shown may be out of date.</p>
    </div>
  );
}
