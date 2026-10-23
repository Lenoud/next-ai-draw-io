/** 只记录固定错误分类；SDK 异常可能携带 API Key、请求正文和响应正文。 */
export function logChatError(
    event: string,
    error: unknown,
    code: string,
    requestId?: string,
) {
    const value = error as { statusCode?: unknown; status?: unknown } | null
    const status = value?.statusCode ?? value?.status
    console.error(
        JSON.stringify({
            event,
            code,
            ...(typeof status === "number" &&
            Number.isInteger(status) &&
            status >= 100 &&
            status <= 599
                ? { upstream_status: status }
                : {}),
            ...(requestId && /^[a-f0-9-]{36}$/.test(requestId)
                ? { request_id: requestId }
                : {}),
        }),
    )
}
