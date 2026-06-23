/**
 * /trace — full-screen embed of VictoriaLogs vmui.
 *
 * vmui is a complete React app served by VL at /select/vmui/. We iframe it so
 * sysadmin gets filter/table/histogram/LogsQL editor without having to write
 * a custom UI — saves ~5 dev days vs DIY trace components.
 */
export default function TracePage() {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-4">
          <a href="/chat" className="text-sm font-semibold tracking-tight">← onelog</a>
          <span className="text-xs text-muted">Trace (vmui)</span>
        </div>
        <a
          href="/select/vmui/"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted hover:text-fg"
        >
          Mở full tab ↗
        </a>
      </header>
      <iframe
        src="/select/vmui/"
        title="VictoriaLogs vmui"
        className="flex-1 w-full border-0"
      />
    </div>
  );
}
