import type { Capture } from "../types";
import { redactHeaders } from "../lib/redact";
import { rebuildAssistantFromSSE } from "../lib/sse";
import JsonBlock from "./JsonBlock";
import EmptyState from "./EmptyState";

interface ResponseTabProps {
  capture: Capture;
}

export default function ResponseTab({ capture }: ResponseTabProps) {
  const res = capture.response || {};
  const sse = res.sse_events || [];
  const hasBody = res.body !== undefined && res.body !== null;
  const status = res.status_code ?? res.status;
  const badgeCls =
    status === 200 ? "ok" : status && status >= 400 ? "err" : "neutral";

  const ct = res.headers?.["content-type"] || res.headers?.["Content-Type"] || "—";

  return (
    <div>
      <div className="meta-table">
        <div className="kv">
          <div className="k">Status</div>
          <div>
            <span className={`badge ${badgeCls}`}>{status ?? "—"}</span>
          </div>
        </div>
        <div className="kv">
          <div className="k">SSE Events</div>
          <div>{sse.length}</div>
        </div>
        <div className="kv">
          <div className="k">Has Body</div>
          <div>{hasBody ? "yes" : "no"}</div>
        </div>
        <div className="kv">
          <div className="k">Content-Type</div>
          <div>{ct}</div>
        </div>
      </div>

      {res.headers && Object.keys(res.headers).length > 0 && (
        <>
          <h3 className="section">Response headers</h3>
          <JsonBlock value={redactHeaders(res.headers)} variant="raw" />
        </>
      )}

      {sse.length > 0 && (() => {
        const rebuilt = rebuildAssistantFromSSE(sse);
        if (!rebuilt) return null;
        return (
          <>
            <h3 className="section">Reassembled content blocks</h3>
            <div
              style={{
                marginBottom: 10,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.04em",
              }}
            >
              {rebuilt.length} block{rebuilt.length === 1 ? "" : "s"} reconstructed
              from {sse.length} SSE events
            </div>
            <JsonBlock value={rebuilt} />
          </>
        );
      })()}

      {hasBody && (() => {
        let bodyStr: string;
        try {
          bodyStr =
            typeof res.body === "string"
              ? res.body
              : JSON.stringify(res.body, null, 2);
        } catch {
          bodyStr = String(res.body);
        }
        const trimmed = bodyStr.trim();
        const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
        if (isJson) {
          try {
            const parsed = JSON.parse(trimmed);
            return (
              <>
                <h3 className="section">Response body</h3>
                <JsonBlock value={parsed} />
              </>
            );
          } catch {
            return (
              <>
                <h3 className="section">Response body</h3>
                <pre className="json">{bodyStr}</pre>
              </>
            );
          }
        }
        return (
          <>
            <h3 className="section">Response body</h3>
            <pre className="json">{bodyStr}</pre>
          </>
        );
      })()}

      {sse.length === 0 && !hasBody && (
        <EmptyState
          big="No response captured"
          small="NEITHER SSE EVENTS NOR A RESPONSE BODY WAS RECORDED"
          style={{ padding: "60px 20px" }}
        />
      )}
    </div>
  );
}
