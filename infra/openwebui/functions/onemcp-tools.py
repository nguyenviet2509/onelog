"""
title: OneMCP Tools
author: onelog
version: 0.1.0
description: LLM-callable tools bridging OpenWebUI to OneMCP KB (search + get + templates + skills).
requirements: httpx
"""

# Function OpenWebUI · plan 260723-1200-onemcp-openwebui-bridge Phase 2.
# LLM tự gọi các tool này. `onemcp_search` hardcode filter status=published để chỉ
# trả entries đã verify. Auth qua static bot user (X-Onemcp-User: openwebui-bot).
# TLS verify default TRUE — mount OneMCP CA cert vào openwebui container ở
# /usr/local/share/ca-certificates/onemcp.crt + update-ca-certificates (Phase 1 gate V2).

import json
import time
from typing import Any

import httpx
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        ONEMCP_URL: str = Field(
            default="https://192.168.122.56",
            description="Base URL của OneMCP nginx (không kèm /api/mcp).",
        )
        BOT_USER: str = Field(
            default="openwebui-bot",
            description="X-Onemcp-User header. Bot contributor role — submit pending only.",
        )
        ONEMCP_CA_PATH: str = Field(
            default="/opt/onemcp-ca.crt",
            description="Path tới OneMCP self-signed cert mounted vào container. "
            "Đặt rỗng để tắt TLS verify (chỉ dev-local).",
        )
        TIMEOUT_SEC: float = Field(default=5.0, description="HTTP timeout per RPC call.")

    def __init__(self):
        self.valves = self.Valves()

    async def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """POST /api/mcp — JSON-RPC 2.0. Trả .result (không unwrap error để LLM thấy)."""
        # Phase 0 instrumentation (plan 260724-0805): đo per-call latency để verify
        # hypothesis "network overhead + multi-query = bottleneck chat". Xoá sau Phase 4.
        t0 = time.perf_counter()
        tool_name = params.get("name", method) if isinstance(params, dict) else method
        url = f"{self.valves.ONEMCP_URL.rstrip('/')}/api/mcp"
        headers = {
            "X-Onemcp-User": self.valves.BOT_USER,
            "Content-Type": "application/json",
        }
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        verify_arg: bool | str = self.valves.ONEMCP_CA_PATH or False
        status = "ok"
        try:
            async with httpx.AsyncClient(
                verify=verify_arg, timeout=self.valves.TIMEOUT_SEC
            ) as client:
                try:
                    r = await client.post(url, json=payload, headers=headers)
                    r.raise_for_status()
                    data = r.json()
                except httpx.TimeoutException:
                    status = "timeout"
                    return {"status": "kb_unavailable", "code": "timeout",
                            "message": f"OneMCP {tool_name} > {self.valves.TIMEOUT_SEC}s"}
                except httpx.RequestError as e:
                    status = "network_error"
                    return {"status": "kb_unavailable", "code": "network",
                            "message": f"OneMCP unreachable: {type(e).__name__}"}
                except httpx.HTTPStatusError as e:
                    status = f"http_{e.response.status_code}"
                    if 500 <= e.response.status_code < 600:
                        return {"status": "kb_unavailable", "code": "http_5xx",
                                "message": f"OneMCP {e.response.status_code}"}
                    # 4xx = auth/validation → giữ verbose để debug
                    return {"error": f"OneMCP HTTP {e.response.status_code}: {e.response.text[:200]}"}
            if "error" in data:
                status = "rpc_error"
                return {"error": f"OneMCP RPC error: {data['error']}"}
            return data.get("result", {})
        finally:
            dt_ms = (time.perf_counter() - t0) * 1000
            # flush=True để log xuất hiện realtime trong `docker logs -f`
            print(
                f"[onemcp-tools] tool={tool_name} status={status} took={dt_ms:.0f}ms",
                flush=True,
            )

    async def onemcp_search(self, query: str, limit: int = 10) -> str:
        """
        Search OneMCP KB (published artifacts only). Vietnamese unaccent-aware FTS + trigram.
        Gọi tool này TRƯỚC TIÊN cho mọi câu hỏi về lỗi/incident/log/service down.
        1 call duy nhất với query rich — gộp VN + EN + service name vào cùng chuỗi.
        VD: "nginx 502 upstream timeout gateway lỗi". KHÔNG chia làm nhiều calls.
        :param query: Full keyword string (VN + EN + service name gộp).
        :param limit: Max entries trả về (default 10).
        :return: JSON string list results với title, tags, service, score, snippet 25 words.
        """
        res = await self._rpc(
            "tools/call",
            {"name": "search", "arguments": {"q": query, "limit": limit, "status": "published"}},
        )
        return json.dumps(res, ensure_ascii=False)

    async def onemcp_get(self, artifact_id: str) -> str:
        """
        Fetch full artifact body + metadata by ID. Dùng sau khi search hit để lấy chi tiết.
        :param artifact_id: ID artifact (UUID hoặc slug).
        :return: JSON string với body markdown + structured content + verify status.
        """
        res = await self._rpc(
            "tools/call", {"name": "get_artifact", "arguments": {"id": artifact_id}}
        )
        return json.dumps(res, ensure_ascii=False)

    async def onemcp_get_template(self, artifact_type: str) -> str:
        """
        Fetch template schema cho 1 artifact type (kb|report|research|postmortem|runbook).
        LLM đọc để biết fields required/optional + validation trước khi submit.
        :param artifact_type: Loại artifact.
        :return: JSON template với list fields (key, type, required, minLength, placeholder).
        """
        res = await self._rpc(
            "tools/call", {"name": "get_artifact_template", "arguments": {"type": artifact_type}}
        )
        return json.dumps(res, ensure_ascii=False)

    async def onemcp_list_skills(self) -> str:
        """List skills khả dụng (git-synced từ skills-kythuat repo). Trả list {id, name, version}."""
        res = await self._rpc("tools/call", {"name": "list_skills", "arguments": {}})
        return json.dumps(res, ensure_ascii=False)

    async def onemcp_load_skill(self, skill_id: str) -> str:
        """Load SKILL.md body của 1 skill. Dùng khi muốn áp dụng skill vào task hiện tại."""
        res = await self._rpc(
            "tools/call", {"name": "load_skill", "arguments": {"id": skill_id}}
        )
        return json.dumps(res, ensure_ascii=False)
