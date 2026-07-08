import type { Capture } from "../types";

interface RawJsonTabProps {
  capture: Capture;
}

export default function RawJsonTab({ capture }: RawJsonTabProps) {
  return <pre className="json">{JSON.stringify(capture, null, 2)}</pre>;
}
