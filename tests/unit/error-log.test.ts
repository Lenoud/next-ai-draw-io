import { afterEach, expect, test, vi } from "vitest"
import { logChatError } from "../../lib/error-log"

afterEach(() => vi.restoreAllMocks())

test("模型错误日志只保留分类、上游状态和有效请求编号", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {})
    const error = Object.assign(new Error("private-response-body"), {
        statusCode: 429,
        url: "https://example.test/private-path?token=private-query",
        requestHeaders: { Authorization: "Bearer private-key" },
        requestBodyValues: { prompt: "private-prompt" },
    })
    const id = "9e316870-e811-49a2-97a8-8b0164200901"
    logChatError("chat_stream_error", error, "rate_limited", id)
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
        event: "chat_stream_error",
        code: "rate_limited",
        upstream_status: 429,
        request_id: id,
    })
    expect(output.mock.calls[0][0]).not.toContain("private-")
    logChatError(
        "chat_stream_error",
        error,
        "rate_limited",
        "invalid-request-id",
    )
    expect(JSON.parse(output.mock.calls[1][0])).not.toHaveProperty("request_id")
})
