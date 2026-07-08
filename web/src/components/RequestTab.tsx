import { redactHeaders } from "../lib/redact";
import type { Capture } from "../types";
import JsonBlock from "./JsonBlock";

interface RequestTabProps {
  capture: Capture;
}

export default function RequestTab({ capture }: RequestTabProps) {
  const req = capture.request || {};
  const tools = req.body?.tools || [];
  return (
    <div>
      <div className="meta-table">
        <div className="kv">
          <div className="k">URL</div>
          <div>{req.url || ""}</div>
        </div>
        <div className="kv">
          <div className="k">Method</div>
          <div>{req.method || ""}</div>
        </div>
      </div>

      <h3 className="section">Headers</h3>
      <JsonBlock value={redactHeaders(req.headers)} variant="raw" />

      {tools.length > 0 && (
        <>
          <h3 className="section">Tools · {tools.length} declared</h3>
          {tools.map((t, i) => {
            const name = t.name || t.function?.name || "(unnamed)";
            return (
              <details key={i}>
                <summary>{name}</summary>
                <pre className="json" style={{ marginTop: 8 }}>
                  {JSON.stringify(t, null, 2)}
                </pre>
              </details>
            );
          })}
        </>
      )}

      <h3 className="section">Request body</h3>
      <JsonBlock value={req.body} variant="raw" />
    </div>
  );
}
