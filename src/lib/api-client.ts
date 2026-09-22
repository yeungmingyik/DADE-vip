export const staticDemo = process.env.NEXT_PUBLIC_STATIC_DEMO === "true";

export async function apiRequest(input: string, init?: RequestInit): Promise<Response> {
  if (staticDemo) {
    const { demoRequest } = await import("@/demo/service");
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return demoRequest(input, init);
  }
  return fetch(input, init);
}

export async function downloadExport(path: string): Promise<void> {
  const response = await apiRequest(path);
  if (!response.ok) throw new Error("Export failed");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sspc-purchases.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}
