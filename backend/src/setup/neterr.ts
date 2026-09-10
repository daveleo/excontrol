/** Classify a low-level network error from fetch()/net into a wizard-friendly reason. */
export function netReason(e: unknown, hostPort: string): { detail: string; hint: "unreachable" | "bad-response" } | null {
  const err = e as { name?: string; code?: string; cause?: { code?: string; message?: string }; message?: string };
  const code = err.code ?? err.cause?.code;
  if (err.name === "AbortError" || err.name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return { detail: `No response from ${hostPort} within a few seconds — check the IP address and that the device is powered on.`, hint: "unreachable" };
  }
  if (code === "ECONNREFUSED") {
    return { detail: `Nothing is listening on ${hostPort} — the IP is reachable but the control port is closed. Check the port and that the service is enabled on the device.`, hint: "unreachable" };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { detail: `Cannot resolve "${hostPort.split(":")[0]}" — use the device's IP address.`, hint: "unreachable" };
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return { detail: `${hostPort} is on an unreachable network — check cabling / subnet.`, hint: "unreachable" };
  }
  if (code === "ECONNRESET") {
    return { detail: `${hostPort} closed the connection unexpectedly — often a protocol or encryption mismatch.`, hint: "bad-response" };
  }
  return null;
}
