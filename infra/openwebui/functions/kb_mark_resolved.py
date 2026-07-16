"""
OpenWebUI Action Function — kb_mark_resolved

Adds a "Mark Resolved" button to the message toolbar in OpenWebUI.
When clicked, posts the current chat to the KB summarize endpoint,
then returns a markdown link for the member to review and save the draft.

Install: OpenWebUI Admin → Functions → + Add Function → paste this file.
Type: Action (button in message toolbar).

Valves (configurable in Admin UI):
  KB_WEB_URL  — base URL of the Next.js web service (default: http://web:3000)
  TIMEOUT_S   — HTTP timeout seconds (default: 15)
"""

from typing import Optional
import httpx
from pydantic import BaseModel


class Action:
    class Valves(BaseModel):
        KB_WEB_URL: str = "http://web:3000"
        TIMEOUT_S: int = 15

    def __init__(self):
        self.valves = self.Valves()

    async def action(
        self,
        body: dict,
        __user__: Optional[dict] = None,
        __request__=None,
    ) -> Optional[dict]:
        """
        Called when member clicks the "Mark Resolved" toolbar button.

        body.chat_id    — current OpenWebUI chat id
        __user__.token  — user JWT (available in OpenWebUI >= 0.4.x)
        __request__     — Starlette request object (fallback JWT source)
        """
        # --- Extract chat_id ---
        chat_id = body.get("chat_id") or body.get("id")
        if not chat_id:
            return {"content": "KB error: could not determine chat id."}

        # --- Extract JWT (prefer __user__.token, fallback to request header) ---
        jwt: str = ""
        if __user__ and isinstance(__user__, dict):
            jwt = __user__.get("token", "")
        if not jwt and __request__ is not None:
            auth_header = ""
            try:
                auth_header = __request__.headers.get("authorization", "")
            except Exception:
                pass
            jwt = auth_header

        if not jwt:
            return {"content": "KB error: no auth token available. Please reload and try again."}

        # Ensure "Bearer " prefix
        if not jwt.startswith("Bearer "):
            jwt = f"Bearer {jwt}"

        # --- Call KB summarize endpoint ---
        url = f"{self.valves.KB_WEB_URL}/api/kb/summarize"
        try:
            async with httpx.AsyncClient(timeout=self.valves.TIMEOUT_S) as client:
                resp = await client.post(
                    url,
                    headers={
                        "Authorization": jwt,
                        "Content-Type": "application/json",
                    },
                    json={"chatId": chat_id},
                )
        except httpx.TimeoutException:
            return {
                "content": (
                    f"KB timeout — summarization took more than {self.valves.TIMEOUT_S}s. "
                    "Try again or contact the SRE team."
                )
            }
        except httpx.RequestError as exc:
            return {"content": f"KB connection error: {exc}"}

        # --- Handle response ---
        status = resp.status_code

        if status == 200:
            try:
                data = resp.json()
            except Exception:
                return {"content": "KB error: invalid response from summarize endpoint."}

            review_url = data.get("reviewUrl", "")
            draft_id = data.get("draftId", "")

            if not review_url:
                # Fallback: construct URL manually if reviewUrl missing
                review_url = (
                    f"{self.valves.KB_WEB_URL}/kb/create"
                    f"?draft={draft_id}"
                )

            return {
                "content": (
                    "KB draft ready — review and save within 30 minutes.\n\n"
                    f"[Review + Save KB Entry]({review_url})"
                )
            }

        if status == 429:
            return {
                "content": (
                    "KB rate limit reached — you can create at most 20 KB entries per day. "
                    "Try again tomorrow."
                )
            }

        if status == 403:
            return {
                "content": (
                    "KB error: you are not the owner of this chat. "
                    "Only the chat owner can mark it as resolved."
                )
            }

        if status == 401:
            return {
                "content": (
                    "KB error: authentication failed. "
                    "Please reload the page and try again."
                )
            }

        if status == 422:
            return {"content": "KB error: this chat has no messages to summarize."}

        if status >= 500:
            return {
                "content": (
                    f"KB service error ({status}). "
                    "The summarization service may be temporarily unavailable. "
                    "Please try again in a few minutes."
                )
            }

        return {"content": f"KB unexpected response ({status}). Please try again."}
