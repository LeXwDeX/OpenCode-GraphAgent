const REQUEST_TIMEOUT_MS = 1000;

function validPort(port: number) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export async function isOpenCodeHealthy(port: number, timeout = REQUEST_TIMEOUT_MS): Promise<boolean> {
  if (!validPort(port)) {return false;}
  try {
    const response = await fetch(`http://localhost:${port}/global/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {return false;}
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "healthy" in body &&
      body.healthy === true &&
      "version" in body &&
      typeof body.version === "string" &&
      body.version.trim().length > 0
    );
  } catch {
    return false;
  }
}

export async function appendPrompt(port: number, text: string): Promise<boolean> {
  if (!(await isOpenCodeHealthy(port))) {return false;}
  try {
    const response = await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
