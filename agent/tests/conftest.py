"""Force mock modes BEFORE any agent module loads its `settings` singleton."""
from __future__ import annotations

import os

os.environ.setdefault("LLM_MOCK", "true")
os.environ.setdefault("EMBED_MOCK", "true")
os.environ.setdefault("ANTHROPIC_API_KEY", "")
os.environ.setdefault("OPENAI_API_KEY", "")
