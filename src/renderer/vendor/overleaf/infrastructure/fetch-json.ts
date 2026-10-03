/**
 * Eukolia substitution for Overleaf's `infrastructure/fetch-json`.
 *
 * The figure modal's URL source only needs "fetch this JSON, report failures".
 * Eukolia performs the request with `fetch` and throws an `Error` carrying the
 * status, matching the shape the ported call sites expect.
 */
export interface FetchJsonError extends Error {
  status: number
  response: Response
  data?: unknown
}

export default async function fetchJson<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  })

  let data: unknown
  try {
    data = await response.json()
  } catch {
    data = undefined
  }

  if (!response.ok) {
    const error = new Error(
      `Request to ${url} failed with status ${response.status}`
    ) as FetchJsonError
    error.status = response.status
    error.response = response
    error.data = data
    throw error
  }

  return data as T
}
