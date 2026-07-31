"""
title: BookStack (KB.inet) Tools
author: onelog
version: 0.1.0
description: LLM-callable tools cho KB.inet (BookStack). 3 tool whitelist với docstring VN chi tiết để LLM không tự chế keyword.
requirements: httpx
"""

# Function OpenWebUI · plan 260731-0847-bookstack-function-wrapper.
# Thay thế bookstack-mcp qua mcpo — Function gọi thẳng https://kb.inet.vn/api/*
# (đã có eth1 route qua iNET internal, bypass 宝塔 WAF).
#
# Vì sao Function thay vì raw mcpo:
# - Docstring Python = tool description LLM đọc. Docstring chi tiết bằng VN
#   với examples cụ thể → LLM không tự guess params, không fabricate keyword.
# - Whitelist cứng 3 tool (search_pages, get_page, get_recent_changes),
#   không expose 17 tool còn lại của bookstack-mcp (write / export / etc.).
# - Bypass mcpo → cắt 1 layer failure (đã gặp socket hang up bug với mcpo 0.0.20).

import json
import time
from typing import Any

import httpx
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        KB_INET_URL: str = Field(
            default="https://kb.inet.vn",
            description="Base URL của BookStack KB.inet (không kèm /api).",
        )
        KB_INET_TOKEN_ID: str = Field(
            default="",
            description="BookStack API Token ID (bot user read-only).",
        )
        KB_INET_TOKEN_SECRET: str = Field(
            default="",
            description="BookStack API Token Secret. Nhập qua Function Valve, không commit.",
        )
        TIMEOUT_SEC: float = Field(
            default=6.0,
            description="HTTP timeout per API call (giây).",
        )

    def __init__(self):
        self.valves = self.Valves()

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """GET https://kb.inet.vn/api/<path>?<params>. Trả JSON hoặc dict lỗi."""
        t0 = time.perf_counter()
        url = f"{self.valves.KB_INET_URL.rstrip('/')}/api/{path.lstrip('/')}"
        headers = {
            "Authorization": f"Token {self.valves.KB_INET_TOKEN_ID}:{self.valves.KB_INET_TOKEN_SECRET}",
            "Accept": "application/json",
        }
        status = "ok"
        try:
            async with httpx.AsyncClient(timeout=self.valves.TIMEOUT_SEC) as client:
                try:
                    r = await client.get(url, params=params, headers=headers)
                    r.raise_for_status()
                    return r.json()
                except httpx.TimeoutException:
                    status = "timeout"
                    return {"status": "kb_unavailable", "code": "timeout",
                            "message": f"KB.inet {path} timeout > {self.valves.TIMEOUT_SEC}s"}
                except httpx.RequestError as e:
                    status = "network_error"
                    return {"status": "kb_unavailable", "code": "network",
                            "message": f"KB.inet unreachable: {type(e).__name__}"}
                except httpx.HTTPStatusError as e:
                    status = f"http_{e.response.status_code}"
                    if 500 <= e.response.status_code < 600:
                        return {"status": "kb_unavailable", "code": "http_5xx",
                                "message": f"KB.inet HTTP {e.response.status_code}"}
                    return {"error": f"KB.inet HTTP {e.response.status_code}: {e.response.text[:200]}"}
        finally:
            dt_ms = (time.perf_counter() - t0) * 1000
            print(f"[bookstack-tools] path={path} status={status} took={dt_ms:.0f}ms", flush=True)

    async def bookstack_search_pages(
        self,
        query: str,
        count: int = 10,
    ) -> str:
        """
        Tìm page trong KB.inet theo full-text search (diacritic-fold VN).

        Dùng cho câu hỏi tra cứu SOP / how-to / cấu hình sản phẩm iNET:
        - "Cách khắc phục lỗi Redis OOM trên cPanel"
        - "Hướng dẫn cài OnePanel CentOS 7"
        - "Cấu hình Zimbra forwarding"
        - "Chặn IP quốc tế trên MikroTik"
        - Câu ép "tìm trong KB có tài liệu về X"

        NGUYÊN TẮC PARAM:
        - `query`: gộp keyword rich từ câu user (VN + EN + tên sản phẩm), 1 call duy nhất.
          VD user hỏi "Redis OOM cPanel" → query="Redis OOM cPanel" (không thêm/bớt).
        - KHÔNG rewrite câu user với năm/số như "2025 2026 mới nhất" — user chưa nói năm.
        - KHÔNG dùng tool này cho câu hỏi THỜI GIAN ("có gì mới tuần này"). Câu đó dùng
          `bookstack_get_recent_changes` với `days` param.

        Response: JSON với `results[]` chứa {id, name, url, updated_at, preview_html.content}.
        LIST kết quả cho user với title + link + snippet ngắn. Cite `url` (kb.inet.vn/...).

        Nếu 0 results → nói "không tìm thấy trong KB.inet". KHÔNG retry với keyword khác.

        :param query: Từ khóa search — bám sát câu user, không tự chế.
        :param count: Max kết quả (default 10, max 30).
        :return: JSON string với results array.
        """
        res = await self._get("search", {"query": query, "count": min(count, 30)})
        return json.dumps(res, ensure_ascii=False)

    async def bookstack_get_page(self, page_id: int) -> str:
        """
        Lấy full nội dung markdown của 1 page KB.inet theo ID.

        Dùng sau khi `bookstack_search_pages` trả về 1 hit relevant và user muốn đọc chi tiết,
        hoặc user chỉ định 1 page cụ thể bằng ID/URL.

        Response: JSON với `name`, `markdown` (nội dung đầy đủ), `url`, `updated_at`, `tags[]`.
        Trả cho user phần `markdown` (đã format markdown), cite `url`.

        :param page_id: ID số nguyên của page (lấy từ `results[].id` của search).
        :return: JSON string page details.
        """
        # BookStack API: /api/pages/{id}?markdown=true để lấy plain markdown
        res = await self._get(f"pages/{page_id}", {"markdown": "true"})
        return json.dumps(res, ensure_ascii=False)

    async def bookstack_get_recent_changes(
        self,
        days: int = 7,
        limit: int = 20,
    ) -> str:
        """
        Xem KB.inet có page nào MỚI hoặc CẬP NHẬT trong N ngày gần đây.

        Dùng cho câu hỏi THỜI GIAN:
        - "KB có gì mới tuần này"        → days=7
        - "KB có gì mới hôm nay"          → days=1
        - "KB có gì mới tháng này"        → days=30
        - "KB có gì cập nhật gần đây"     → days=7 (default)
        - "Tài liệu mới trong 3 ngày"     → days=3

        Mapping VN → days:
        - "hôm nay" = 1
        - "hôm qua" = 2 (bao gồm cả hôm nay)
        - "tuần này" / "tuần qua" = 7
        - "nửa tháng" / "2 tuần" = 14
        - "tháng này" / "tháng qua" = 30

        TUYỆT ĐỐI KHÔNG:
        - Dùng `bookstack_search_pages` với keyword thời gian ("mới nhất 2025 2026").
        - Tự chế năm/số. User nói "tuần này" = 7 ngày kể từ hôm nay, KHÔNG search year.
        - Retry với keyword khác nếu 0 results — nói thẳng "không có page mới trong X ngày".

        Response: JSON với `results[]` chứa {id, name, url, updated_at, book_id}.
        Sort sẵn theo `updated_at` desc. LIST tất cả cho user, mỗi item: tên + link + ngày cập nhật.

        :param days: Số ngày lùi từ hôm nay. Default 7. Range hợp lệ 1-90.
        :param limit: Max entries. Default 20.
        :return: JSON string với results.
        """
        # BookStack không có endpoint /api/recent-changes chuẩn.
        # Dùng /api/pages sorted by updated_at desc, filter client-side theo days.
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 90)))
        cutoff_str = cutoff.strftime("%Y-%m-%dT%H:%M:%S.000000Z")
        res = await self._get("pages", {
            "count": min(limit, 50),
            "sort": "-updated_at",
            "filter[updated_at:gt]": cutoff_str,
        })
        # Slim response — giữ field LLM cần, giảm token
        if isinstance(res, dict) and "data" in res:
            slim = {
                "days_window": days,
                "cutoff": cutoff_str,
                "total": res.get("total", len(res["data"])),
                "returned": len(res["data"]),
                "results": [
                    {
                        "id": p.get("id"),
                        "name": p.get("name"),
                        "url": f"{self.valves.KB_INET_URL.rstrip('/')}/books/{p.get('book_slug', p.get('book_id'))}/page/{p.get('slug', '')}",
                        "updated_at": p.get("updated_at"),
                        "book_id": p.get("book_id"),
                    }
                    for p in res["data"]
                ],
            }
            return json.dumps(slim, ensure_ascii=False)
        return json.dumps(res, ensure_ascii=False)
